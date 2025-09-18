import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import spawn, { SubprocessError } from 'nano-spawn';

const nodeRequire = createRequire(import.meta.url);

export type CliInvocation = {
	executable: string;
	prefixArgs: string[];
};

/**
 * Resolves the binary path for a package
 */
export function resolveBinaryPath(packageName: string): string {
	let packageJsonPath: string;
	try {
		packageJsonPath = nodeRequire.resolve(`${packageName}/package.json`);
	}
	catch (error) {
		throw new Error(`Unable to resolve ${packageName}. Install the package alongside @ccusage/mcp to enable ${packageName} tools.`, { cause: error });
	}

	const packageJson = nodeRequire(packageJsonPath) as { bin?: string; publishConfig?: { bin?: string } };
	const binField = packageJson.bin ?? packageJson.publishConfig?.bin;

	if (typeof binField !== 'string') {
		throw new TypeError(`Unable to locate binary entry in ${packageName}/package.json`);
	}

	const packageDir = path.dirname(packageJsonPath);
	return path.resolve(packageDir, binField);
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
