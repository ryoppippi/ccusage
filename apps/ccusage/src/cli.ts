#!/usr/bin/env bun

import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE, CCUSAGE_BUN_AUTO_RUN_ENV } from './_env.ts';
import { main } from './main.ts';

function shouldRunNodeEntry(envValue = process.env[CCUSAGE_BUN_AUTO_RUN_ENV]): boolean {
	return envValue === CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE;
}

async function runNodeEntry(argv: string[]): Promise<number> {
	const distDir = dirname(fileURLToPath(import.meta.url));
	const entryPath = join(distDir, 'main.node.js');
	const child = Bun.spawn(['node', entryPath, ...argv], {
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});

	return child.exited;
}

async function runCli(argv: string[]): Promise<void> {
	if (shouldRunNodeEntry()) {
		process.exitCode = await runNodeEntry(argv);
		return;
	}

	await main();
}

if (import.meta.vitest == null) {
	await runCli(process.argv.slice(2));
}

if (import.meta.vitest != null) {
	describe('shouldRunNodeEntry', () => {
		it('keeps the Bun entry as the default launcher path', () => {
			expect(shouldRunNodeEntry(undefined)).toBe(false);
		});

		it('uses the Node entry when the auto-Bun path is disabled', () => {
			expect(shouldRunNodeEntry(CCUSAGE_BUN_AUTO_RUN_DISABLED_VALUE)).toBe(true);
		});
	});
}
