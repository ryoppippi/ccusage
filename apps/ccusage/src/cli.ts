#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE, CCUSAGE_BUN_AUTO_RUN_ENV } from './env.ts';
import { isSupportedNodeVersion } from './node-version.ts';
import { getSupportedNodeRuntime } from './runtime-macro.ts' with { type: 'macro' };

const SUPPORTED_NODE_RUNTIME = getSupportedNodeRuntime();
const require = createRequire(import.meta.url);

const nativePackageNames = new Map<string, string>(
	Object.entries({
		'darwin-arm64': '@ccusage/ccusage-darwin-arm64',
		'darwin-x64': '@ccusage/ccusage-darwin-x64',
		'linux-arm64': '@ccusage/ccusage-linux-arm64',
		'linux-x64': '@ccusage/ccusage-linux-x64',
		'win32-arm64': '@ccusage/ccusage-win32-arm64',
		'win32-x64': '@ccusage/ccusage-win32-x64',
	} as const satisfies Record<string, string>),
);

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

function getNativePackageName(
	platform: string = process.platform,
	arch: string = process.arch,
): string | undefined {
	return nativePackageNames.get(`${platform}-${arch}`);
}

function getNativeBinarySubpath(platform: string = process.platform): string {
	return platform === 'win32' ? 'bin/ccusage.exe' : 'bin/ccusage';
}

function resolveNativeBinary({
	arch = process.arch,
	isExecutablePath = isExecutable,
	platform = process.platform,
	resolvePath = (id) => require.resolve(id),
}: {
	arch?: string;
	isExecutablePath?: (path: string) => boolean;
	platform?: string;
	resolvePath?: (id: string) => string;
} = {}): string | undefined {
	const packageName = getNativePackageName(platform, arch);
	if (packageName == null) {
		return undefined;
	}

	try {
		const binaryPath = resolvePath(`${packageName}/${getNativeBinarySubpath(platform)}`);
		return isExecutablePath(binaryPath) ? binaryPath : undefined;
	} catch {
		return undefined;
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

function isBun(): boolean {
	return (globalThis as { Bun?: unknown }).Bun != null;
}

function getUnsupportedNodeRuntimeMessage(nodeVersion = process.version): string | undefined {
	if (isSupportedNodeVersion(nodeVersion, SUPPORTED_NODE_RUNTIME.minimum)) {
		return undefined;
	}

	return `ccusage requires Bun or Node.js ${SUPPORTED_NODE_RUNTIME.range}. Current Node.js: ${nodeVersion}\n`;
}

async function runBunMain(): Promise<void> {
	await import('./main.bun.ts');
}

function resolveCliRuntime({
	argv,
	bunAutoRunValue = process.env[CCUSAGE_BUN_AUTO_RUN_ENV],
	distDir,
	findBunPath = () => findExecutableInPath('bun'),
	nativeBinaryPath = resolveNativeBinary(),
	nodeVersion = process.version,
	processExecPath = process.execPath,
}: {
	argv: string[];
	bunAutoRunValue?: string;
	distDir: string;
	findBunPath?: () => string | undefined;
	nativeBinaryPath?: string | null;
	nodeVersion?: string;
	processExecPath?: string;
}): CliRuntime {
	if (nativeBinaryPath != null) {
		return {
			args: argv,
			command: nativeBinaryPath,
		};
	}

	const bunPath =
		bunAutoRunValue !== CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE ? findBunPath() : undefined;
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

async function runCli(
	argv: string[],
	{
		isBunRuntime = isBun(),
		runBun = runBunMain,
	}: {
		isBunRuntime?: boolean;
		runBun?: () => Promise<void>;
	} = {},
): Promise<number> {
	if (isBunRuntime) {
		await runBun();
		return 0;
	}

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
		it('resolves the native package binary for the current supported platform', () => {
			expect(
				resolveNativeBinary({
					arch: 'arm64',
					isExecutablePath: (path) => path === '/native/bin/ccusage',
					platform: 'darwin',
					resolvePath: (id) => {
						expect(id).toBe('@ccusage/ccusage-darwin-arm64/bin/ccusage');
						return '/native/bin/ccusage';
					},
				}),
			).toBe('/native/bin/ccusage');
		});

		it('resolves the Windows native package binary with the exe suffix', () => {
			expect(
				resolveNativeBinary({
					arch: 'arm64',
					isExecutablePath: (path) => path === 'C:\\native\\bin\\ccusage.exe',
					platform: 'win32',
					resolvePath: (id) => {
						expect(id).toBe('@ccusage/ccusage-win32-arm64/bin/ccusage.exe');
						return 'C:\\native\\bin\\ccusage.exe';
					},
				}),
			).toBe('C:\\native\\bin\\ccusage.exe');
		});

		it('prefers the matching native package binary when it is available', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => '/usr/local/bin/bun',
					nativeBinaryPath: '/app/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage',
					nodeVersion: 'v22.10.0',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				args: ['daily'],
				command: '/app/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage',
			});
		});

		it('keeps using Bun when Node.js is unsupported but Bun is available', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => '/usr/local/bin/bun',
					nativeBinaryPath: null,
					nodeVersion: 'v22.10.0',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				args: ['/app/dist/main.bun.js', 'daily'],
				command: '/usr/local/bin/bun',
			});
		});

		it('uses Node.js 23 when Bun is unavailable', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => undefined,
					nativeBinaryPath: null,
					nodeVersion: 'v23.11.1',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				args: ['/app/dist/main.node.js', 'daily'],
				command: '/usr/bin/node',
			});
		});

		it('uses the minimum supported Node.js version when Bun is unavailable', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => undefined,
					nativeBinaryPath: null,
					nodeVersion: 'v22.11.0',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				args: ['/app/dist/main.node.js', 'daily'],
				command: '/usr/bin/node',
			});
		});

		it('rejects Node.js below the supported range when Bun is unavailable', () => {
			expect(
				resolveCliRuntime({
					argv: ['daily'],
					distDir: '/app/dist',
					findBunPath: () => undefined,
					nativeBinaryPath: null,
					nodeVersion: 'v22.10.0',
					processExecPath: '/usr/bin/node',
				}),
			).toEqual({
				errorMessage: 'ccusage requires Bun or Node.js >=22.11.0. Current Node.js: v22.10.0\n',
			});
		});
	});

	describe('runCli', () => {
		it('imports the Bun entrypoint directly under Bun', async () => {
			const runBun = vi.fn(async () => {});

			await expect(runCli(['daily'], { isBunRuntime: true, runBun })).resolves.toBe(0);

			expect(runBun).toHaveBeenCalledOnce();
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
