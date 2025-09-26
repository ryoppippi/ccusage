import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import spawn, { SubprocessError } from 'nano-spawn';

const nodeRequire = createRequire(import.meta.url);

export type BinField = string | Record<string, string> | undefined;

export type CliInvocation = {
	executable: string;
	prefixArgs: string[];
};

/**
 * Resolves the binary path for a package
 */
export function resolveBinaryPath(
	packageName: string,
	binName?: string,
): string {
	let packageJsonPath: string;
	try {
		packageJsonPath = nodeRequire.resolve(`${packageName}/package.json`);
	}
	catch (error) {
		throw new Error(`Unable to resolve ${packageName}. Install the package alongside @better-ccusage/mcp to enable ${packageName} tools.`, { cause: error });
	}

	const packageJson = nodeRequire(packageJsonPath) as { bin?: BinField; publishConfig?: { bin?: BinField } };
	const binField: BinField = packageJson.bin ?? packageJson.publishConfig?.bin;

	let binRelative: string | undefined;
	if (typeof binField === 'string') {
		binRelative = binField;
	}
	else if (binField != null && typeof binField === 'object') {
		binRelative = (binName != null && binName !== '') ? binField[binName] : Object.values(binField)[0];
	}

	if (binRelative == null) {
		throw new Error(`Unable to locate ${binName ?? packageName} binary entry in ${packageName}/package.json`);
	}

	const packageDir = path.dirname(packageJsonPath);
	return path.resolve(packageDir, binRelative);
}

/**
 * Creates invocation config for CLI execution
 */
export function createCliInvocation(entryPath: string): CliInvocation {
	// Use bun for TypeScript files in development
	if (entryPath.endsWith('.ts')) {
		return {
			executable: 'bun',
			prefixArgs: [entryPath],
		};
	}
	// Use node for built JavaScript files in production
	return {
		executable: process.execPath,
		prefixArgs: [entryPath],
	};
}

/**
 * Executes a CLI command and returns the output
 */
export async function executeCliCommand(
	executable: string,
	args: string[],
	env?: Record<string, string>,
): Promise<string> {
	try {
		const result = await spawn(executable, args, {
			env: {
				...process.env,
				// Suppress color output
				FORCE_COLOR: '0',
				// nano-spawn captures stdout, so it won't leak to terminal
				...env,
			},
		});
		const output = (result.stdout ?? result.output ?? '').trim();
		if (output === '') {
			throw new Error('CLI command returned empty output');
		}
		return output;
	}
	catch (error: unknown) {
		if (error instanceof SubprocessError) {
			const message = (error.stderr ?? error.stdout ?? error.output ?? error.message).trim();
			throw new Error(message);
		}
		throw error;
	}
}
