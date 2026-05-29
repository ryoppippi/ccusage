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

async function canRunVersion(binary: string | undefined): Promise<boolean> {
	if (binary == null) {
		return false;
	}
	const result = await Bun.$`${binary} --version`.quiet().nothrow();
	return result.exitCode === 0;
}

if ((await nativePackageIncludesBinary(nativePackageRoot)) && (await canRunVersion(nativeBinary))) {
	process.exit(0);
}

await Bun.$`cargo build --manifest-path ${join(repoRoot, 'rust', 'Cargo.toml')} --release --bin ccusage`;

if (!(await canRunVersion(cargoBinary))) {
	throw new Error(`${cargoBinary} did not run --version after cargo build`);
}
