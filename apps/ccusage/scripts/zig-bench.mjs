import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const packageRoot = new URL('..', import.meta.url).pathname;
const repoRoot = new URL('../../..', import.meta.url).pathname;

function parseArgs(argv) {
	const separator = argv.indexOf('--');
	const benchArgs = separator === -1 ? argv : argv.slice(0, separator);
	const cliArgs = separator === -1 ? ['daily', '--offline', '--json'] : argv.slice(separator + 1);
	let samples = 5;
	for (let index = 0; index < benchArgs.length; index++) {
		const arg = benchArgs[index];
		if (arg === '--samples') {
			samples = Number.parseInt(benchArgs[++index], 10);
			continue;
		}
		if (arg === '-h' || arg === '--help') {
			console.log('Usage: pnpm --filter ccusage zig:bench [--samples n] [-- ccusage args...]');
			process.exit(0);
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return { cliArgs, samples };
}

function runCli(command, args) {
	const result = spawnSync(command, args, {
		cwd: packageRoot,
		env: process.env,
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr?.toString('utf8') || `${command} failed`);
	}
}

function measure(name, command, args, samples) {
	runCli(command, args);
	const values = [];
	for (let index = 0; index < samples; index++) {
		const start = process.hrtime.bigint();
		runCli(command, args);
		const end = process.hrtime.bigint();
		values.push(Number(end - start) / 1e6);
	}
	values.sort((a, b) => a - b);
	const sum = values.reduce((acc, value) => acc + value, 0);
	return {
		name,
		avgMs: sum / values.length,
		minMs: values[0],
		p50Ms: values[Math.floor(values.length / 2)],
		maxMs: values.at(-1),
		samples,
	};
}

const { cliArgs, samples } = parseArgs(process.argv.slice(2));
const jsCli = join(packageRoot, 'dist', 'index.js');
const zigCli = join(repoRoot, 'zig-out', 'bin', 'ccusage');

const rows = [
	measure('node dist/index.js', process.execPath, [jsCli, ...cliArgs], samples),
	measure('zig release-small', zigCli, cliArgs, samples),
];

console.log(`Args: ${cliArgs.join(' ')}`);
console.log(
	`JS dist: ${relative(process.cwd(), jsCli)} ${(statSync(jsCli).size / 1024).toFixed(2)} KiB`,
);
console.log(
	`Zig bin: ${relative(process.cwd(), zigCli)} ${(statSync(zigCli).size / 1024).toFixed(2)} KiB`,
);
console.table(
	rows.map((row) => ({
		name: row.name,
		avg: `${row.avgMs.toFixed(2)} ms`,
		min: `${row.minMs.toFixed(2)} ms`,
		p50: `${row.p50Ms.toFixed(2)} ms`,
		max: `${row.maxMs.toFixed(2)} ms`,
		samples: row.samples,
	})),
);
