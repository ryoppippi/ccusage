#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

type CliRuntime =
	| {
			args: string[];
			command: string;
	  }
	| {
			errorMessage: string;
	  };

function getNativePackageName(
	platform: string = process.platform,
	arch: string = process.arch,
): string | undefined {
	if (platform === 'darwin') {
		if (arch === 'arm64') {
			return '@ccusage/ccusage-darwin-arm64';
		}
		if (arch === 'x64') {
			return '@ccusage/ccusage-darwin-x64';
		}
		return undefined;
	}

	if (platform === 'linux') {
		if (arch === 'arm64') {
			return '@ccusage/ccusage-linux-arm64';
		}
		if (arch === 'x64') {
			return '@ccusage/ccusage-linux-x64';
		}
		return undefined;
	}

	if (platform === 'win32') {
		if (arch === 'arm64') {
			return '@ccusage/ccusage-win32-arm64';
		}
		if (arch === 'x64') {
			return '@ccusage/ccusage-win32-x64';
		}
	}

	return undefined;
}

function getNativeBinarySubpath(platform: string = process.platform): string {
	return platform === 'win32' ? 'bin/ccusage.exe' : 'bin/ccusage';
}

function resolveNativeBinary({
	arch = process.arch,
	platform = process.platform,
	resolvePath = (id) => require.resolve(id),
}: {
	arch?: string;
	platform?: string;
	resolvePath?: (id: string) => string;
} = {}): string | undefined {
	const packageName = getNativePackageName(platform, arch);
	if (packageName == null) {
		return undefined;
	}

	try {
		return resolvePath(`${packageName}/${getNativeBinarySubpath(platform)}`);
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

function runCli(argv: string[]): number {
	const runtime = resolveCliRuntime({ argv });
	if ('errorMessage' in runtime) {
		process.stderr.write(runtime.errorMessage);
		return 1;
	}

	const result = spawnSync(runtime.command, runtime.args, { stdio: 'inherit' });
	if (result.error != null) {
		process.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	if (result.signal != null) {
		process.kill(process.pid, result.signal);
		return 1;
	}
	return result.status ?? 1;
}

if (import.meta.vitest == null) {
	process.exitCode = runCli(process.argv.slice(2));
}

if (import.meta.vitest != null) {
	describe('resolveCliRuntime', () => {
		it('resolves the native package binary for the current supported platform', () => {
			expect(
				resolveNativeBinary({
					arch: 'arm64',
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
