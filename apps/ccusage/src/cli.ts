#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await runCli(process.argv.slice(2));
}

export { ensureNativeBinaryExecutable, resolveCliRuntime, resolveNativeBinary };
