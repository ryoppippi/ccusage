import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageDirs = {
	'darwin-arm64': 'ccusage-darwin-arm64',
	'darwin-x64': 'ccusage-darwin-x64',
	'linux-arm64': 'ccusage-linux-arm64',
	'linux-x64': 'ccusage-linux-x64',
	'win32-arm64': 'ccusage-win32-arm64',
	'win32-x64': 'ccusage-win32-x64',
};

function readOption(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) {
		return fallback;
	}
	const value = process.argv[index + 1];
	if (value == null || value.startsWith('--')) {
		throw new Error(`--${name} requires a value`);
	}
	return value;
}

function rewriteDarwinSystemLibraries(binaryPath) {
	const linkedLibraries = execFileSync('otool', ['-L', binaryPath], { encoding: 'utf8' });
	for (const line of linkedLibraries.split('\n')) {
		const library = line.trim().split(/\s+/)[0];
		if (/^\/nix\/store\/[^/]+-libiconv-[^/]+\/lib\/libiconv\.2\.dylib$/.test(library)) {
			execFileSync('install_name_tool', [
				'-change',
				library,
				'/usr/lib/libiconv.2.dylib',
				binaryPath,
			]);
		}
	}
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const platform = readOption('platform', process.platform);
const arch = readOption('arch', process.arch);
const key = `${platform}-${arch}`;
const packageDir = packageDirs[key];

if (packageDir == null) {
	throw new Error(`Unsupported native package target: ${key}`);
}

const binaryName = platform === 'win32' ? 'ccusage.exe' : 'ccusage';
const source = resolve(readOption('binary', resolve(repoRoot, 'rust/target/release', binaryName)));
const targetDir = resolve(repoRoot, 'packages', packageDir, 'bin');
const target = resolve(targetDir, binaryName);

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
if (platform !== 'win32') {
	chmodSync(target, 0o755);
}
if (platform === 'darwin') {
	rewriteDarwinSystemLibraries(target);
}

process.stdout.write(`${target}\n`);
