#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE, CCUSAGE_BUN_AUTO_RUN_ENV } from './_env.ts';

const MIN_NODE_MAJOR_VERSION = 22;

type CliRuntime =
	| {
			args: string[];
			command: string;
	  }
	| {
			errorMessage: string;
	  };

function getExecutableNames(
	command: string,
	platform = process.platform,
	pathExt = process.env.PATHEXT,
): string[] {
	if (platform !== 'win32') {
		return [command];
	}

	const extensions = pathExt?.split(';').filter(Boolean) ?? ['.EXE', '.CMD', '.BAT', '.COM'];
	return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) {
			return false;
		}
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findExecutableInPath(
	command: string,
	pathValue = process.env.PATH,
	platform = process.platform,
	pathExt = process.env.PATHEXT,
	isExecutablePath = isExecutable,
): string | undefined {
	if (pathValue == null || pathValue.length === 0) {
		return undefined;
	}

	const executableNames = getExecutableNames(command, platform, pathExt);
	for (const directory of pathValue.split(delimiter)) {
		if (directory.length === 0) {
			continue;
		}
		for (const executableName of executableNames) {
			const executablePath = join(directory, executableName);
			if (isExecutablePath(executablePath)) {
				return executablePath;
			}
		}
	}

	return undefined;
}

function getNodeMajorVersion(version = process.version): number | undefined {
	const [majorVersion] = version.replace(/^v/, '').split('.');
	const major = Number(majorVersion);
	return Number.isInteger(major) ? major : undefined;
}

function getUnsupportedNodeRuntimeMessage(nodeVersion = process.version): string | undefined {
	const nodeMajorVersion = getNodeMajorVersion(nodeVersion);
	if (nodeMajorVersion == null || nodeMajorVersion >= MIN_NODE_MAJOR_VERSION) {
		return undefined;
	}

	return `ccusage requires Bun or Node.js >=${MIN_NODE_MAJOR_VERSION}.0.0. Current Node.js: ${nodeVersion}\n`;
}

function resolveCliRuntime({
	argv,
	bunAutoRunValue = process.env[CCUSAGE_BUN_AUTO_RUN_ENV],
	distDir,
	findBunPath = () => findExecutableInPath('bun'),
	isRunningInBun = process.versions.bun != null,
	nodeVersion = process.version,
	processExecPath = process.execPath,
}: {
	argv: string[];
	bunAutoRunValue?: string;
	distDir: string;
	findBunPath?: () => string | undefined;
	isRunningInBun?: boolean;
	nodeVersion?: string;
	processExecPath?: string;
}): CliRuntime {
	const bunPath =
		bunAutoRunValue !== CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE
			? isRunningInBun
				? processExecPath
				: findBunPath()
			: undefined;
	if (bunPath != null) {
		return {
			args: [join(distDir, 'main.bun.js'), ...argv],
			command: bunPath,
		};
	}

	const errorMessage = getUnsupportedNodeRuntimeMessage(nodeVersion);
	if (errorMessage != null) {
		return { errorMessage };
	}

	return {
		args: [join(distDir, 'main.node.js'), ...argv],
		command: processExecPath,
	};
}

async function runCli(argv: string[]): Promise<number> {
	const distDir = dirname(fileURLToPath(import.meta.url));
	const runtime = resolveCliRuntime({ argv, distDir });
	if ('errorMessage' in runtime) {
		process.stderr.write(runtime.errorMessage);
		return 1;
	}

	const child = spawn(runtime.command, runtime.args, { stdio: 'inherit' });

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

if (import.meta.vitest == null) {
	process.exitCode = await runCli(process.argv.slice(2));
}

if (import.meta.vitest != null) {
	describe('resolveCliRuntime', () => {
		it('keeps using Bun when Node.js is unsupported but Bun is available', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => '/usr/local/bin/bun',
					isRunningInBun: false,
					nodeVersion: 'v22.13.1',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				args: ['/app/dist/main.bun.js', 'daily'],
				command: '/usr/local/bin/bun',
			});
		});

		it('rejects Node.js 21 when Bun is unavailable', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => undefined,
					isRunningInBun: false,
					nodeVersion: 'v21.7.3',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				errorMessage: 'ccusage requires Bun or Node.js >=22.0.0. Current Node.js: v21.7.3\n',
			});
		});
	});

	describe('findExecutableInPath', () => {
		it('finds an executable by scanning PATH directly', () => {
			expect(
				findExecutableInPath(
					'bun',
					'/usr/bin:/opt/bin',
					'darwin',
					undefined,
					(path) => path === '/opt/bin/bun',
				),
			).toBe('/opt/bin/bun');
		});

		it('ignores non-executable files', () => {
			expect(
				findExecutableInPath('bun', '/usr/bin:/opt/bin', 'darwin', undefined, () => false),
			).toBeUndefined();
		});
	});
}
