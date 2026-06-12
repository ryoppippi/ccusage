#!/usr/bin/env bun

import { join, resolve } from 'node:path';
import { arch, platform } from 'node:process';

const nativePackageDirs = new Map([
	['darwin-arm64', 'ccusage-darwin-arm64'],
	['darwin-x64', 'ccusage-darwin-x64'],
	['linux-arm64', 'ccusage-linux-arm64'],
	['linux-x64', 'ccusage-linux-x64'],
	['android-arm64', 'ccusage-linux-arm64'],
	['win32-arm64', 'ccusage-win32-arm64'],
	['win32-x64', 'ccusage-win32-x64'],
]);

const repoRoot = resolve(import.meta.dir, '../../..');
const targetKey = `${platform}-${arch}`;
const nativePackageDir = nativePackageDirs.get(targetKey);
const binaryName = platform === 'win32' ? 'ccusage.exe' : 'ccusage';
const nativePackageRoot =
	nativePackageDir == null ? undefined : join(repoRoot, 'packages', nativePackageDir);
const nativeBinary =
	nativePackageRoot == null ? undefined : join(nativePackageRoot, 'bin', binaryName);
const cargoBinary = join(repoRoot, 'rust', 'target', 'release', binaryName);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && !Array.isArray(value);
}

async function expectedVersion(): Promise<string> {
	const packageJson: unknown = await Bun.file(
		join(repoRoot, 'apps', 'ccusage', 'package.json'),
	).json();
	if (!isRecord(packageJson) || typeof packageJson.version !== 'string') {
		throw new TypeError('apps/ccusage/package.json version is not configured');
	}
	return packageJson.version;
}

async function nativePackageIncludesBinary(packageRoot: string | undefined): Promise<boolean> {
	if (packageRoot == null) {
		return false;
	}
	let packageJson: unknown;
	try {
		packageJson = await Bun.file(join(packageRoot, 'package.json')).json();
	} catch {
		return false;
	}
	if (!isRecord(packageJson)) {
		return false;
	}
	const files = packageJson.files;
	return Array.isArray(files) && files.includes(`bin/${binaryName}`);
}

/**
 * Dylib prefixes that exist on every macOS installation. Anything else
 * (such as /nix/store paths) only exists on the build machine and crashes
 * the binary for end users with a missing dynamic library error.
 */
const systemDylibPrefixes = ['/usr/lib/', '/System/Library/'];

/**
 * Checks that a binary can run on end-user machines without dynamic
 * libraries that only exist on the build machine.
 *
 * - Linux: the binary must be fully static (the release pipeline builds
 *   against musl), because a glibc or Nix-linked binary fails outside the
 *   build environment.
 * - macOS: fully static linking is not supported, so the binary must link
 *   only system dylibs under {@link systemDylibPrefixes}.
 * - Windows: not checked; MSVC builds link only system DLLs by default.
 *
 * @param binary - Path to the binary to inspect
 * @returns Whether the binary is safe to ship to end users
 */
async function isPortableBinary(binary: string | undefined): Promise<boolean> {
	if (binary == null) {
		return false;
	}
	if (platform === 'linux' || platform === 'android') {
		// ldd exits non-zero for static executables, so inspect the combined
		// output instead of the exit code (mirrors the release CI check).
		const result = await Bun.$`ldd ${binary}`.quiet().nothrow();
		const output = `${result.stdout.toString()}${result.stderr.toString()}`;
		return /not a dynamic executable|statically linked/i.test(output);
	}
	if (platform === 'darwin') {
		const result = await Bun.$`otool -L ${binary}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			return false;
		}
		// otool -L prints the binary path on the first line, then one indented
		// line per linked dylib: "\t/usr/lib/libSystem.B.dylib (compatibility ...)".
		const dylibs = result.stdout
			.toString()
			.split('\n')
			.slice(1)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => line.split(/\s+/).at(0) ?? '');
		return dylibs.every((dylib) => systemDylibPrefixes.some((prefix) => dylib.startsWith(prefix)));
	}
	return true;
}

async function hasExpectedVersion(binary: string | undefined, version: string): Promise<boolean> {
	if (binary == null) {
		return false;
	}
	const result = await Bun.$`${binary} --version`.quiet().nothrow();
	if (result.exitCode !== 0) {
		return false;
	}
	const actualVersion = result.stdout.toString().trim().split(/\s+/).at(-1);
	return actualVersion === version;
}

const version = await expectedVersion();

if (
	(await nativePackageIncludesBinary(nativePackageRoot)) &&
	(await hasExpectedVersion(nativeBinary, version))
) {
	if (!(await isPortableBinary(nativeBinary))) {
		throw new Error(
			`${nativeBinary} depends on dynamic libraries that do not exist on end-user machines; rebuild it (Linux packages must be static, macOS packages may only link system dylibs)`,
		);
	}
	process.exit(0);
}

await Bun.$`cargo build --manifest-path ${join(repoRoot, 'rust', 'Cargo.toml')} --release --bin ccusage`;

if (!(await hasExpectedVersion(cargoBinary, version))) {
	throw new Error(`${cargoBinary} did not report version ${version} after cargo build`);
}
