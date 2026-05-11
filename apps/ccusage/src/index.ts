#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, env, exit, platform } from 'node:process';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(currentDir, '../../..');
const exe = platform === 'win32' ? 'ccusage.exe' : 'ccusage';
const candidates = [join(rootDir, 'target', 'release', exe), join(rootDir, 'target', 'debug', exe)];

const binary = candidates.find((candidate) => existsSync(candidate));
const args = argv.slice(2);

const result =
	binary == null
		? spawnSync(
				env.CARGO ?? 'cargo',
				[
					'run',
					'--quiet',
					'--manifest-path',
					join(rootDir, 'Cargo.toml'),
					'--bin',
					'ccusage',
					'--',
					...args,
				],
				{
					stdio: 'inherit',
					env,
				},
			)
		: spawnSync(binary, args, {
				stdio: 'inherit',
				env,
			});

if (result.error != null) {
	throw result.error;
}

if (result.signal != null) {
	exit(1);
}

exit(result.status ?? 0);
