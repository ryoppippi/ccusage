#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
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

type FileMode = {
	mode: number;
};

type NativeSpawnResult = {
	error?: Error;
	signal?: NodeJS.Signals | null;
	status: number | null;
};

type NativeSpawner = (command: string, args: string[]) => Promise<NativeSpawnResult>;

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

	if (platform === 'linux' || platform === 'android') {
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureNativeBinaryExecutable({
	binaryPath,
	chmodPath = chmodSync,
	platform = process.platform,
	statPath = statSync,
}: {
	binaryPath: string;
	chmodPath?: (path: string, mode: number) => void;
	platform?: string;
	statPath?: (path: string) => FileMode;
}): string | undefined {
	if (platform === 'win32') {
		return undefined;
	}

	try {
		const mode = statPath(binaryPath).mode;
		if ((mode & 0o111) !== 0) {
			return undefined;
		}
		chmodPath(binaryPath, 0o755);
		return undefined;
	} catch (error) {
		return `ccusage native binary is not executable: ${errorMessage(error)}\n`;
	}
}

function createNativeSpawner(): NativeSpawner {
	return async (command, args) =>
		new Promise((resolve) => {
			const child = spawn(command, args, { stdio: 'inherit' });
			child.on('error', (error) => {
				resolve({
					error,
					signal: null,
					status: null,
				});
			});
			child.on('exit', (status, signal) => {
				resolve({
					signal,
					status,
				});
			});
		});
}

async function runCli(
	argv: string[],
	spawnNative: NativeSpawner = createNativeSpawner(),
): Promise<number> {
	const runtime = resolveCliRuntime({ argv });
	if ('errorMessage' in runtime) {
		process.stderr.write(runtime.errorMessage);
		return 1;
	}

	const executableError = ensureNativeBinaryExecutable({
		binaryPath: runtime.command,
	});
	if (executableError != null) {
		process.stderr.write(executableError);
		return 1;
	}

	const result = await spawnNative(runtime.command, runtime.args);
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
	process.exitCode = await runCli(process.argv.slice(2));
}

if (import.meta.vitest != null) {
	describe(resolveCliRuntime, () => {
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

		it('repairs a native binary that was extracted without executable bits', () => {
			const chmodPath = vi.fn();

			expect(
				ensureNativeBinaryExecutable({
					binaryPath: '/native/bin/ccusage',
					chmodPath,
					platform: 'linux',
					statPath: () => ({ mode: 0o644 }),
				}),
			).toBeUndefined();
			expect(chmodPath).toHaveBeenCalledWith('/native/bin/ccusage', 0o755);
		});

		it('does not chmod an already executable native binary', () => {
			const chmodPath = vi.fn();

			expect(
				ensureNativeBinaryExecutable({
					binaryPath: '/native/bin/ccusage',
					chmodPath,
					platform: 'darwin',
					statPath: () => ({ mode: 0o755 }),
				}),
			).toBeUndefined();
			expect(chmodPath).not.toHaveBeenCalled();
		});

		it('does not chmod Windows native binaries', () => {
			const chmodPath = vi.fn();

			expect(
				ensureNativeBinaryExecutable({
					binaryPath: 'C:\\native\\bin\\ccusage.exe',
					chmodPath,
					platform: 'win32',
					statPath: () => ({ mode: 0o644 }),
				}),
			).toBeUndefined();
			expect(chmodPath).not.toHaveBeenCalled();
		});
	});
}
