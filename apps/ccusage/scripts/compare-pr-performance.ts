#!/usr/bin/env bun

import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { measure } from 'mitata';

type Options = {
	baseDir?: string;
	fixtureDir?: string;
	headDir?: string;
	output?: string;
	runs: number;
	warmup: number;
};

type CommandMeasurement = {
	max: number;
	median: number;
	min: number;
	samples: number;
};

type CommandResult = {
	base: CommandMeasurement;
	command: string;
	head: CommandMeasurement;
};

type SizeComparison = {
	base: number;
	head: number;
};

function parseArgs(args: string[]): Options {
	const options: Options = {
		runs: 7,
		warmup: 2,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg == null) {
			continue;
		}
		switch (arg) {
			case '--base-dir':
				if (value == null) {
					throw new Error('--base-dir requires a value');
				}
				options.baseDir = resolve(value);
				index++;
				break;
			case '--head-dir':
				if (value == null) {
					throw new Error('--head-dir requires a value');
				}
				options.headDir = resolve(value);
				index++;
				break;
			case '--fixture-dir':
				if (value == null) {
					throw new Error('--fixture-dir requires a value');
				}
				options.fixtureDir = resolve(value);
				index++;
				break;
			case '--output':
				if (value == null) {
					throw new Error('--output requires a value');
				}
				options.output = resolve(value);
				index++;
				break;
			case '--runs':
				if (value == null) {
					throw new Error('--runs requires a value');
				}
				options.runs = Number.parseInt(value, 10);
				index++;
				break;
			case '--warmup':
				if (value == null) {
					throw new Error('--warmup requires a value');
				}
				options.warmup = Number.parseInt(value, 10);
				index++;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	if (options.baseDir == null || options.headDir == null || options.fixtureDir == null) {
		throw new Error('--base-dir, --head-dir, and --fixture-dir are required');
	}
	if (!Number.isInteger(options.runs) || options.runs < 1) {
		throw new Error('--runs must be a positive integer');
	}
	if (!Number.isInteger(options.warmup) || options.warmup < 0) {
		throw new Error('--warmup must be a non-negative integer');
	}

	return options;
}

function distDir(repoDir: string): string {
	return join(repoDir, 'apps', 'ccusage', 'dist');
}

function builtEntry(repoDir: string): string {
	return join(distDir(repoDir), 'index.js');
}

async function directorySizeBytes(dir: string): Promise<number> {
	let total = 0;
	const glob = new Bun.Glob('**/*');
	for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
		total += Bun.file(join(dir, path)).size;
	}
	return total;
}

function formatDuration(milliseconds: number): string {
	return milliseconds >= 1000
		? `${(milliseconds / 1000).toFixed(3)}s`
		: `${milliseconds.toFixed(1)}ms`;
}

function formatSize(bytes: number): string {
	return `${(bytes / 1024).toFixed(2)} KiB`;
}

async function runCcusage(repoDir: string, fixtureDir: string, command: string): Promise<void> {
	const proc = Bun.spawn(
		['pnpm', 'exec', 'bun', '-b', builtEntry(repoDir), command, '--offline', '--json'],
		{
			cwd: repoDir,
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'pipe',
			env: {
				...Bun.env,
				CLAUDE_CONFIG_DIR: fixtureDir,
				COLUMNS: '200',
				LOG_LEVEL: '0',
				NO_COLOR: '1',
				TZ: 'UTC',
			},
		},
	);
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const relativeLabel = relative(process.cwd(), repoDir);
		const label = relativeLabel.length === 0 ? repoDir : relativeLabel;
		const stderr = await new Response(proc.stderr).text();
		const trimmedStderr = stderr.trim();
		throw new Error(
			`${label} ${command} failed: ${trimmedStderr.length === 0 ? `exit ${exitCode}` : trimmedStderr}`,
		);
	}
}

async function measureCommand(
	repoDir: string,
	fixtureDir: string,
	command: string,
	options: Required<Pick<Options, 'runs' | 'warmup'>>,
): Promise<CommandMeasurement> {
	for (let index = 0; index < options.warmup; index++) {
		await runCcusage(repoDir, fixtureDir, command);
	}

	const stats = await measure(
		async () => {
			await runCcusage(repoDir, fixtureDir, command);
		},
		{
			max_samples: options.runs,
			min_cpu_time: 0,
			min_samples: options.runs,
			warmup_threshold: 0,
		},
	);

	return {
		max: stats.max / 1e6,
		median: stats.p50 / 1e6,
		min: stats.min / 1e6,
		samples: stats.ticks,
	};
}

async function compareCommand(
	command: string,
	options: Required<Pick<Options, 'baseDir' | 'fixtureDir' | 'headDir' | 'runs' | 'warmup'>>,
): Promise<CommandResult> {
	const base = await measureCommand(options.baseDir, options.fixtureDir, command, options);
	const head = await measureCommand(options.headDir, options.fixtureDir, command, options);

	return {
		base,
		command,
		head,
	};
}

function renderMarkdown(
	results: CommandResult[],
	sizes: SizeComparison,
	options: Required<Pick<Options, 'fixtureDir' | 'headDir' | 'runs' | 'warmup'>>,
): string {
	const lines = [
		'<!-- ccusage-perf-comment -->',
		'## ccusage fixture performance',
		'',
		'This compares the PR build against the base branch build using the committed ccusage CLI fixture.',
		'',
		`Fixture: \`${relative(options.headDir, options.fixtureDir)}\``,
		`Runtime: built \`apps/ccusage/dist/index.js\` through \`bun -b\`, \`--offline --json\`, measured by \`mitata\` with \`${options.warmup}\` explicit warmups and \`${options.runs}\` samples.`,
		'',
		'| Command | Base median | PR median | PR vs base |',
		'| --- | ---: | ---: | ---: |',
	];

	for (const result of results) {
		const speedup = result.base.median / result.head.median;
		lines.push(
			`| \`${result.command} --offline --json\` | ${formatDuration(result.base.median)} | ${formatDuration(result.head.median)} | ${speedup.toFixed(2)}x |`,
		);
	}

	const sizeDelta = sizes.head - sizes.base;
	const sizeRatio = sizes.base / sizes.head;
	lines.push(
		'',
		'| Bundle | Base | PR | Delta | Ratio |',
		'| --- | ---: | ---: | ---: | ---: |',
		`| \`apps/ccusage/dist\` total | ${formatSize(sizes.base)} | ${formatSize(sizes.head)} | ${sizeDelta >= 0 ? '+' : ''}${formatSize(sizeDelta)} | ${sizeRatio.toFixed(2)}x |`,
		'',
		'Lower medians and smaller bundle sizes are better. CI runner noise still applies; use same-run ratios as directional PR feedback, not release guarantees.',
		'',
	);

	return `${lines.join('\n')}\n`;
}

const options = parseArgs(Bun.argv.slice(2));
if (options.baseDir == null || options.headDir == null || options.fixtureDir == null) {
	throw new Error('unreachable');
}

const requiredOptions = {
	baseDir: options.baseDir,
	fixtureDir: options.fixtureDir,
	headDir: options.headDir,
	runs: options.runs,
	warmup: options.warmup,
};
const commands = ['daily', 'session', 'blocks'];

const results: CommandResult[] = [];
for (const command of commands) {
	results.push(await compareCommand(command, requiredOptions));
}

const sizes = {
	base: await directorySizeBytes(distDir(options.baseDir)),
	head: await directorySizeBytes(distDir(options.headDir)),
};

const markdown = renderMarkdown(results, sizes, requiredOptions);
if (options.output == null) {
	await Bun.write(Bun.stdout, markdown);
} else {
	await Bun.write(options.output, markdown);
}
