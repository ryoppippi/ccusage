#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE, CCUSAGE_BUN_AUTO_RUN_ENV } from './_env.ts';

function getExecutableNames(
	command: string,
	platform = process.platform,
	pathExt = process.env.PATHEXT,
): string[] {
	if (platform !== 'win32') {
		return [command];
	}

	const extensions = pathExt?.split(';').filter(Boolean) ?? ['.EXE', '.CMD', '.BAT', '.COM'];
	return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

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

function findExecutableInPath(
	command: string,
	pathValue = process.env.PATH,
	platform = process.platform,
	pathExt = process.env.PATHEXT,
	isExecutablePath = isExecutable,
): string | undefined {
	if (pathValue == null || pathValue.length === 0) {
		return undefined;
	}

	const executableNames = getExecutableNames(command, platform, pathExt);
	for (const directory of pathValue.split(delimiter)) {
		if (directory.length === 0) {
			continue;
		}
		for (const executableName of executableNames) {
			const executablePath = join(directory, executableName);
			if (isExecutablePath(executablePath)) {
				return executablePath;
			}
		}
	}

	return undefined;
}

async function runCli(argv: string[]): Promise<number> {
	const distDir = dirname(fileURLToPath(import.meta.url));
	const bunPath =
		process.env[CCUSAGE_BUN_AUTO_RUN_ENV] !== CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE
			? process.versions.bun == null
				? findExecutableInPath('bun')
				: process.execPath
			: undefined;
	const entryPath = join(distDir, bunPath == null ? 'main.node.js' : 'main.bun.js');

	const child =
		bunPath == null
			? spawn(process.execPath, [entryPath, ...argv], { stdio: 'inherit' })
			: spawn(bunPath, [entryPath, ...argv], { stdio: 'inherit' });

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
	describe('findExecutableInPath', () => {
		it('finds an executable by scanning PATH directly', () => {
			expect(
				findExecutableInPath(
					'bun',
					'/usr/bin:/opt/bin',
					'darwin',
					undefined,
					(path) => path === '/opt/bin/bun',
				),
			).toBe('/opt/bin/bun');
		});

		it('ignores non-executable files', () => {
			expect(
				findExecutableInPath('bun', '/usr/bin:/opt/bin', 'darwin', undefined, () => false),
			).toBeUndefined();
		});
	});
}
