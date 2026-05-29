#!/usr/bin/env bun

import { join, resolve } from 'node:path';
import { arch, platform } from 'node:process';

const nativePackageDirs = new Map([
	['darwin-arm64', 'ccusage-darwin-arm64'],
	['darwin-x64', 'ccusage-darwin-x64'],
	['linux-arm64', 'ccusage-linux-arm64'],
	['linux-x64', 'ccusage-linux-x64'],
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
	const packageJson: unknown = await Bun.file(join(packageRoot, 'package.json')).json();
	if (!isRecord(packageJson)) {
		return false;
	}
	const files = packageJson.files;
	return Array.isArray(files) && files.includes(`bin/${binaryName}`);
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
	process.exit(0);
}

await Bun.$`cargo build --manifest-path ${join(repoRoot, 'rust', 'Cargo.toml')} --release --bin ccusage`;

if (!(await hasExpectedVersion(cargoBinary, version))) {
	throw new Error(`${cargoBinary} did not report version ${version} after cargo build`);
}
