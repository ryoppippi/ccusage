#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { bench, measure, run, summary } from 'mitata';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, '..');
const builtCli = join(packageRoot, 'dist', 'index.js');

function parseArgs(args) {
	let full = false;
	let name = 'ccusage --offline --json';
	let samples = 3;
	const separatorIndex = args.indexOf('--');
	const benchArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
	const cliArgs = separatorIndex === -1 ? ['--offline', '--json'] : args.slice(separatorIndex + 1);

	for (let index = 0; index < benchArgs.length; index++) {
		const arg = benchArgs[index];
		const value = benchArgs[index + 1];

		if (arg === '--name') {
			if (value == null) {
				throw new Error('--name requires a value');
			}
			name = value;
			index++;
			continue;
		}

		if (arg === '--samples') {
			if (value == null) {
				throw new Error('--samples requires a value');
			}
			samples = Number.parseInt(value, 10);
			index++;
			continue;
		}

		if (arg === '--full') {
			full = true;
			continue;
		}

		if (arg === '--help' || arg === '-h') {
			printHelp();
			process.exit(0);
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	if (full) {
		return { cliArgs, full, name, samples };
	}

	if (!Number.isInteger(samples) || samples < 1) {
		throw new Error('--samples must be a positive integer');
	}

	return { cliArgs, full, name, samples };
}

function printHelp() {
	console.log(`Usage: pnpm --filter ccusage bench [options] [-- ccusage args...]

Options:
  --full            Use mitata summary output with its default sample tuning
  --name <name>     Benchmark task name
  --samples <n>     Number of measured CLI runs in bounded mode (default: 3)
  -h, --help        Show this help

Examples:
  pnpm --filter ccusage bench
  pnpm --filter ccusage bench --full
  pnpm --filter ccusage bench --samples 1
  pnpm --filter ccusage bench -- --offline --json session
  pnpm --filter ccusage bench -- --offline --json --since 20260101`);
}

function runCli(cliArgs) {
	const result = spawnSync(process.execPath, [builtCli, ...cliArgs], {
		cwd: packageRoot,
		stdio: ['ignore', 'ignore', 'pipe'],
		env: process.env,
	});

	if (result.status !== 0) {
		const stderr = result.stderr?.toString('utf8').trim();
		throw new Error(stderr || `ccusage exited with status ${result.status ?? 'unknown'}`);
	}
}

function formatTime(nanoseconds) {
	if (nanoseconds >= 1e9) {
		return `${(nanoseconds / 1e9).toFixed(2)} s`;
	}
	if (nanoseconds >= 1e6) {
		return `${(nanoseconds / 1e6).toFixed(2)} ms`;
	}
	if (nanoseconds >= 1e3) {
		return `${(nanoseconds / 1e3).toFixed(2)} us`;
	}
	return `${nanoseconds.toFixed(2)} ns`;
}

const { cliArgs, full, name, samples } = parseArgs(process.argv.slice(2));

if (!existsSync(builtCli)) {
	throw new Error('Built CLI not found. Run `pnpm --filter ccusage build` first.');
}

console.log(`Node: ${process.version}`);
console.log(`CLI: ${relative(process.cwd(), builtCli)}`);
console.log(`Size: ${(statSync(builtCli).size / 1024).toFixed(2)} KiB`);
console.log(`Args: ${cliArgs.join(' ')}`);

if (full) {
	summary(() => {
		bench(name, () => runCli(cliArgs)).gc('inner');
	});
	await run({ colors: false });
	process.exit(0);
}

console.log(`Samples: ${samples}`);

let calls = 0;
const stats = await measure(
	() => {
		if (calls++ === 0) {
			return;
		}
		runCli(cliArgs);
	},
	{
		min_samples: samples,
		max_samples: samples,
		min_cpu_time: 0,
		warmup_threshold: 0,
	},
);

console.table([
	{
		name,
		avg: formatTime(stats.avg),
		min: formatTime(stats.min),
		p50: formatTime(stats.p50),
		p75: formatTime(stats.p75),
		p99: formatTime(stats.p99),
		max: formatTime(stats.max),
		samples: stats.ticks,
	},
]);
