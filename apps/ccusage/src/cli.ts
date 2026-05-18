#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

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

function resolveCliRuntime({
	argv,
	arch = process.arch,
	nativeBinaryPath = resolveNativeBinary(),
	platform = process.platform,
}: {
	arch?: string;
	argv: string[];
	nativeBinaryPath?: string | null;
	platform?: string;
}): CliRuntime {
	if (nativeBinaryPath != null) {
		return {
			args: argv,
			command: nativeBinaryPath,
		};
	}

	return {
		errorMessage: `ccusage native binary is not available for ${platform}-${arch}. Reinstall ccusage so optional native dependencies are installed.\n`,
	};
}

async function runCli(argv: string[]): Promise<number> {
	const runtime = resolveCliRuntime({ argv });
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
					nativeBinaryPath: '/app/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage',
				}),
			).toEqual({
				args: ['daily'],
				command: '/app/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage',
			});
		});

		it('fails when the native package binary is unavailable', () => {
			expect(
				resolveCliRuntime({
					arch: 'arm64',
					argv: ['daily'],
					nativeBinaryPath: null,
					platform: 'darwin',
				}),
			).toEqual({
				errorMessage:
					'ccusage native binary is not available for darwin-arm64. Reinstall ccusage so optional native dependencies are installed.\n',
			});
		});
	});
}
