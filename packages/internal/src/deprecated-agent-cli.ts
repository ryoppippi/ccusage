import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type DeprecatedAgentCliOptions = {
	agent: string;
	binaryName: string;
	packageName: string;
};

type PackageJson = {
	bin?: string | Record<string, string>;
	publishConfig?: {
		bin?: string | Record<string, string>;
	};
};

export function stripDeprecatedAgentBinaryName(args: string[], binaryName: string): string[] {
	if (args[0] === binaryName) {
		return args.slice(1);
	}
	return args;
}

export function formatDeprecatedAgentWarning(packageName: string, agent: string): string {
	return `${packageName} is deprecated. Use "ccusage ${agent}" instead. This command will be removed in a future version.\n`;
}

function getCcusageBinPath(packageJsonPath: string, packageJson: PackageJson): string {
	const bin = packageJson.publishConfig?.bin ?? packageJson.bin;
	const binPath = typeof bin === 'string' ? bin : bin?.ccusage;
	return resolve(dirname(packageJsonPath), binPath ?? './dist/cli.js');
}

async function resolveCcusageCliPath(): Promise<string> {
	const packageJsonUrl = import.meta.resolve('ccusage/package.json');
	const packageJsonPath = fileURLToPath(packageJsonUrl);
	const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJson;
	return getCcusageBinPath(packageJsonPath, packageJson);
}

export async function runDeprecatedAgentCli(options: DeprecatedAgentCliOptions): Promise<number> {
	process.stderr.write(formatDeprecatedAgentWarning(options.packageName, options.agent));
	const args = stripDeprecatedAgentBinaryName(process.argv.slice(2), options.binaryName);
	let cliPath: string;
	try {
		cliPath = await resolveCcusageCliPath();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		return 1;
	}
	const child = spawn(process.execPath, [cliPath, options.agent, ...args], { stdio: 'inherit' });

	return new Promise((resolve) => {
		child.on('error', (error) => {
			process.stderr.write(`${error.message}\n`);
			resolve(1);
		});
		child.on('exit', (code, signal) => {
			if (signal != null) {
				process.kill(process.pid, signal);
				return;
			}
			resolve(code ?? 1);
		});
	});
}

if (import.meta.vitest != null) {
	describe('stripDeprecatedAgentBinaryName', () => {
		it('removes the legacy binary name when npx passes it through', () => {
			expect(stripDeprecatedAgentBinaryName(['ccusage-codex', 'daily'], 'ccusage-codex')).toEqual([
				'daily',
			]);
		});

		it('leaves ordinary arguments unchanged', () => {
			expect(stripDeprecatedAgentBinaryName(['monthly'], 'ccusage-codex')).toEqual(['monthly']);
		});
	});

	describe('formatDeprecatedAgentWarning', () => {
		it('points users at the ccusage agent namespace', () => {
			expect(formatDeprecatedAgentWarning('@ccusage/codex', 'codex')).toBe(
				'@ccusage/codex is deprecated. Use "ccusage codex" instead. This command will be removed in a future version.\n',
			);
		});
	});
}
