import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const binaryPath = packageJson.bin?.ccusage;
if (typeof binaryPath !== 'string') {
	throw new TypeError('Native package bin.ccusage is not configured');
}

const resolvedBinaryPath = resolve(process.cwd(), binaryPath);

try {
	const stat = statSync(resolvedBinaryPath);
	if (!stat.isFile()) {
		throw new Error(`${binaryPath} is not a file`);
	}
	if (!binaryPath.endsWith('.exe')) {
		accessSync(resolvedBinaryPath, constants.X_OK);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	throw new Error(`Native package binary is not ready: ${message}`);
}
