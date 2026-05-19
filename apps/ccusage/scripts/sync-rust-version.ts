#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUST_PACKAGES = ['ccusage', 'ccusage-terminal'] as const;

type RustPackage = (typeof RUST_PACKAGES)[number];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '../../..');

export function rustVersionFilePaths(repoRoot = defaultRepoRoot): string[] {
	return [
		...RUST_PACKAGES.map((packageName) =>
			resolve(repoRoot, 'rust/crates', packageName, 'Cargo.toml'),
		),
		resolve(repoRoot, 'rust/Cargo.lock'),
	];
}

async function readPackageVersion(repoRoot: string): Promise<string> {
	const packageJsonPath = resolve(repoRoot, 'apps/ccusage/package.json');
	const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
		version?: unknown;
	};
	if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
		throw new Error(`Missing version in ${packageJsonPath}`);
	}
	return packageJson.version;
}

function replacePackageSectionVersion(contents: string, version: string): string {
	const lines = contents.split('\n');
	let inPackageSection = false;
	let replaced = false;

	const nextLines = lines.map((line) => {
		if (line.startsWith('[')) {
			inPackageSection = line === '[package]';
		}
		if (inPackageSection && line.startsWith('version = ')) {
			replaced = true;
			return `version = "${version}"`;
		}
		return line;
	});

	if (!replaced) {
		throw new Error('Missing package version in Cargo.toml');
	}

	return nextLines.join('\n');
}

function replaceCargoLockPackageVersion(
	contents: string,
	packageName: RustPackage,
	version: string,
): string {
	const lines = contents.split('\n');
	let inTargetPackage = false;
	let replaced = false;

	const nextLines = lines.map((line) => {
		if (line === '[[package]]') {
			inTargetPackage = false;
			return line;
		}
		if (line === `name = "${packageName}"`) {
			inTargetPackage = true;
			return line;
		}
		if (inTargetPackage && line.startsWith('version = ')) {
			replaced = true;
			inTargetPackage = false;
			return `version = "${version}"`;
		}
		return line;
	});

	if (!replaced) {
		throw new Error(`Missing ${packageName} package version in Cargo.lock`);
	}

	return nextLines.join('\n');
}

async function writeIfChanged(filePath: string, contents: string): Promise<void> {
	const current = await readFile(filePath, 'utf8');
	if (current !== contents) {
		await writeFile(filePath, contents);
	}
}

export async function syncRustVersion(repoRoot = defaultRepoRoot): Promise<void> {
	const version = await readPackageVersion(repoRoot);
	for (const packageName of RUST_PACKAGES) {
		const cargoTomlPath = resolve(repoRoot, 'rust/crates', packageName, 'Cargo.toml');
		const cargoToml = await readFile(cargoTomlPath, 'utf8');
		await writeIfChanged(cargoTomlPath, replacePackageSectionVersion(cargoToml, version));
	}

	const cargoLockPath = resolve(repoRoot, 'rust/Cargo.lock');
	const cargoLock = await readFile(cargoLockPath, 'utf8');
	const nextCargoLock = RUST_PACKAGES.reduce(
		(contents, packageName) => replaceCargoLockPackageVersion(contents, packageName, version),
		cargoLock,
	);
	await writeIfChanged(cargoLockPath, nextCargoLock);
}

if (import.meta.vitest != null) {
	describe('syncRustVersion', () => {
		it('syncs Rust package versions from the published npm package', async () => {
			const fixturePath = await mkdtemp(resolve(tmpdir(), 'ccusage-rust-version-'));
			try {
				await writeFixtureFile(
					fixturePath,
					'apps/ccusage/package.json',
					JSON.stringify({ version: '19.0.4' }),
				);
				await writeFixtureFile(
					fixturePath,
					'rust/crates/ccusage/Cargo.toml',
					[
						'[package]',
						'name = "ccusage"',
						'version = "19.0.3"',
						'',
						'[dependencies]',
						'example = { version = "19.0.3" }',
						'',
					].join('\n'),
				);
				await writeFixtureFile(
					fixturePath,
					'rust/crates/ccusage-terminal/Cargo.toml',
					['[package]', 'name = "ccusage-terminal"', 'version = "19.0.3"', ''].join('\n'),
				);
				await writeFixtureFile(
					fixturePath,
					'rust/Cargo.lock',
					[
						'version = 4',
						'',
						'[[package]]',
						'name = "ccusage"',
						'version = "19.0.3"',
						'dependencies = [',
						' "ccusage-terminal",',
						']',
						'',
						'[[package]]',
						'name = "ccusage-terminal"',
						'version = "19.0.3"',
						'',
						'[[package]]',
						'name = "unrelated"',
						'version = "19.0.3"',
						'',
					].join('\n'),
				);

				await syncRustVersion(fixturePath);

				await expect(
					readFile(resolve(fixturePath, 'rust/crates/ccusage/Cargo.toml'), 'utf8'),
				).resolves.toContain(
					'version = "19.0.4"\n\n[dependencies]\nexample = { version = "19.0.3" }',
				);
				await expect(
					readFile(resolve(fixturePath, 'rust/crates/ccusage-terminal/Cargo.toml'), 'utf8'),
				).resolves.toContain('version = "19.0.4"');
				await expect(readFile(resolve(fixturePath, 'rust/Cargo.lock'), 'utf8')).resolves.toBe(
					[
						'version = 4',
						'',
						'[[package]]',
						'name = "ccusage"',
						'version = "19.0.4"',
						'dependencies = [',
						' "ccusage-terminal",',
						']',
						'',
						'[[package]]',
						'name = "ccusage-terminal"',
						'version = "19.0.4"',
						'',
						'[[package]]',
						'name = "unrelated"',
						'version = "19.0.3"',
						'',
					].join('\n'),
				);
			} finally {
				await rm(fixturePath, { force: true, recursive: true });
			}
		});
	});
}

async function writeFixtureFile(
	repoRoot: string,
	relativePath: string,
	contents: string,
): Promise<void> {
	const filePath = resolve(repoRoot, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
}

if (import.meta.main) {
	await syncRustVersion();
}
