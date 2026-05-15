#!/usr/bin/env bun

import { join, relative, resolve } from 'node:path';
import { platform } from 'node:process';
import { createFixture } from 'fs-fixture';
import { cli, define } from 'gunshi';

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

type SampleOptions = {
	runs: number;
	warmup: number;
};

type FixtureComparison = SampleOptions & {
	description: string;
	fixtureDir: string;
	results: CommandResult[];
	title: string;
};

type HyperfineResult = {
	max: number;
	median: number;
	min: number;
	times: number[];
};

type HyperfineExport = {
	results: HyperfineResult[];
};

function baseBuiltEntry(repoDir: string): string {
	return join(repoDir, 'apps', 'ccusage', 'dist', 'index.js');
}

function rustBinary(repoDir: string): string {
	return join(repoDir, 'target', 'release', platform === 'win32' ? 'ccusage.exe' : 'ccusage');
}

function formatDuration(milliseconds: number): string {
	return milliseconds >= 1000
		? `${(milliseconds / 1000).toFixed(3)}s`
		: `${milliseconds.toFixed(1)}ms`;
}

function formatSize(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
		: `${(bytes / 1024).toFixed(2)} KiB`;
}

async function writeProgress(message: string): Promise<void> {
	await Bun.write(Bun.stderr, `[ccusage-rust-perf] ${message}\n`);
}

/**
 * Quotes dynamic paths for hyperfine's shell command strings.
 *
 * Hyperfine executes commands through a shell, which keeps CI logs readable and lets us set
 * per-command environment variables inline. Repository and fixture paths can still contain spaces,
 * so dynamic path segments must be quoted before they are interpolated into the benchmark command.
 */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Builds the JavaScript main-branch command used as the baseline.
 *
 * The baseline intentionally runs the built JS CLI through Bun because that is the fastest known
 * way to execute the current bundled JavaScript implementation. Comparing Rust against Node here
 * would overstate the Rust win by including avoidable JS runtime startup overhead.
 */
function createBaseCommand(repoDir: string, fixtureDir: string, command: string): string {
	const invocation = [
		'env',
		`CLAUDE_CONFIG_DIR=${shellQuote(fixtureDir)}`,
		'COLUMNS=200',
		'LOG_LEVEL=0',
		'NO_COLOR=1',
		'TZ=UTC',
		`pnpm exec bun -b ${shellQuote(baseBuiltEntry(repoDir))} ${command} --offline --json`,
	].join(' ');
	return [`cd ${shellQuote(repoDir)}`, invocation].join(' && ');
}

/**
 * Builds the Rust PR command measured by hyperfine.
 *
 * The PR side uses the release binary directly so the benchmark reflects the Rust implementation's
 * parser, aggregation, and renderer costs without the tiny JavaScript launcher being part of the
 * reported runtime.
 */
function createRustCommand(repoDir: string, fixtureDir: string, command: string): string {
	const invocation = [
		'env',
		`CLAUDE_CONFIG_DIR=${shellQuote(fixtureDir)}`,
		'COLUMNS=200',
		'LOG_LEVEL=0',
		'NO_COLOR=1',
		'TZ=UTC',
		`${shellQuote(rustBinary(repoDir))} ${command} --offline --json`,
	].join(' ');
	return [`cd ${shellQuote(repoDir)}`, invocation].join(' && ');
}

/**
 * Converts hyperfine's seconds-based JSON output to the millisecond values shown in the PR comment.
 */
function measurementFromHyperfine(result: HyperfineResult): CommandMeasurement {
	return {
		max: result.max * 1000,
		median: result.median * 1000,
		min: result.min * 1000,
		samples: result.times.length,
	};
}

async function compareCommand(
	command: string,
	options: {
		baseDir: string;
		fixtureTitle: string;
		fixtureDir: string;
		headDir: string;
		runs: number;
		warmup: number;
	},
): Promise<CommandResult> {
	await writeProgress(`${options.fixtureTitle} / ${command} started`);
	await using fixture = await createFixture({});
	const exportPath = join(fixture.path, 'hyperfine.json');
	const hyperfine = Bun.spawn(
		[
			'hyperfine',
			'--warmup',
			String(options.warmup),
			'--runs',
			String(options.runs),
			'--export-json',
			exportPath,
			'--style',
			'basic',
			'--output',
			'pipe',
			'--sort',
			'command',
			'--command-name',
			'main JS/Bun',
			'--command-name',
			'Rust PR',
			createBaseCommand(options.baseDir, options.fixtureDir, command),
			createRustCommand(options.headDir, options.fixtureDir, command),
		],
		{
			stderr: 'inherit',
			stdout: 'inherit',
		},
	);
	const exitCode = await hyperfine.exited;
	if (exitCode !== 0) {
		throw new Error(`hyperfine failed for ${options.fixtureTitle} / ${command}: exit ${exitCode}`);
	}
	const hyperfineOutput = JSON.parse(await Bun.file(exportPath).text()) as HyperfineExport;
	const [baseResult, headResult] = hyperfineOutput.results;
	if (baseResult == null || headResult == null) {
		throw new Error(`hyperfine did not report both main and Rust results for ${command}`);
	}
	const base = measurementFromHyperfine(baseResult);
	const head = measurementFromHyperfine(headResult);
	await writeProgress(
		`${options.fixtureTitle} / ${command} done: main ${formatDuration(base.median)}, Rust ${formatDuration(head.median)}`,
	);

	return {
		base,
		command,
		head,
	};
}

/**
 * Runs one fixture workload for the Rust-vs-main comparison.
 *
 * The small generated fixture gives stable quick feedback across daily/session/blocks. The large
 * generated fixture runs only `daily` because it exists to catch realistic multi-file scan behavior
 * and the main-branch baseline is intentionally much slower on that 1 GiB workload.
 */
async function compareFixture(options: {
	baseDir: string;
	commands: string[];
	description: string;
	fixtureDir: string;
	headDir: string;
	runs: number;
	title: string;
	warmup: number;
}): Promise<FixtureComparison> {
	const results: CommandResult[] = [];
	await writeProgress(`${options.title} started`);
	for (const command of options.commands) {
		results.push(
			await compareCommand(command, {
				...options,
				fixtureTitle: options.title,
			}),
		);
	}
	await writeProgress(`${options.title} finished`);

	return {
		description: options.description,
		fixtureDir: options.fixtureDir,
		results,
		runs: options.runs,
		title: options.title,
		warmup: options.warmup,
	};
}

/**
 * Keeps generated fixture paths readable while preserving their exact CI location.
 */
function formatFixturePath(headDir: string, fixtureDir: string): string {
	const relativePath = relative(headDir, fixtureDir);
	return relativePath.startsWith('..') ? fixtureDir : relativePath;
}

function renderFixtureSection(section: FixtureComparison, options: { headDir: string }): string[] {
	const lines = [
		`## ${section.title}`,
		'',
		section.description,
		'',
		`Fixture: \`${formatFixturePath(options.headDir, section.fixtureDir)}\``,
		`Runtime: main branch uses built \`apps/ccusage/dist/index.js\` through \`bun -b\`; Rust PR uses \`target/release/ccusage\` directly. Both run \`--offline --json\`, measured by \`hyperfine\` with \`${section.warmup}\` warmups and \`${section.runs}\` runs.`,
		'',
		'| Command | main JS/Bun median | Rust PR median | Rust speedup |',
		'| --- | ---: | ---: | ---: |',
	];

	for (const result of section.results) {
		const speedup = result.base.median / result.head.median;
		lines.push(
			`| \`${result.command} --offline --json\` | ${formatDuration(result.base.median)} | ${formatDuration(result.head.median)} | ${speedup.toFixed(2)}x |`,
		);
	}

	return lines;
}

function renderMarkdown(sections: FixtureComparison[], options: { headDir: string }): string {
	const rustSize = Bun.file(rustBinary(options.headDir)).size;
	const lines = [
		'<!-- ccusage-rust-perf-comment -->',
		'## ccusage Rust performance comparison',
		'',
		'This compares the Rust PR release binary against the base branch JavaScript build on the same CI runner.',
		'',
	];

	for (const section of sections) {
		lines.push(...renderFixtureSection(section, options), '');
	}

	lines.push(
		'## Artifact size',
		'',
		'| Artifact | Size |',
		'| --- | ---: |',
		`| Rust release binary \`target/release/ccusage\` | ${formatSize(rustSize)} |`,
		'',
		'Lower medians and smaller binaries are better. CI runner noise still applies; use same-run ratios as directional PR feedback, not release guarantees.',
		'',
	);

	return `${lines.join('\n')}\n`;
}

/**
 * Rejects accidental zero-sample CI runs before a misleading comment can be posted.
 */
function assertSampleOptions(options: SampleOptions, label: string): void {
	if (!Number.isInteger(options.runs) || options.runs < 1) {
		throw new Error(`--${label}runs must be a positive integer`);
	}
	if (!Number.isInteger(options.warmup) || options.warmup < 0) {
		throw new Error(`--${label}warmup must be a non-negative integer`);
	}
}

const command = define({
	name: 'compare-rust-pr-performance',
	description: 'Compare Rust ccusage PR performance against the JavaScript base branch',
	toKebab: true,
	args: {
		baseDir: {
			type: 'string',
			required: true,
			description: 'Base repository directory',
		},
		fixtureDir: {
			type: 'string',
			required: true,
			description: 'Claude fixture directory used as CLAUDE_CONFIG_DIR',
		},
		headDir: {
			type: 'string',
			required: true,
			description: 'PR/head repository directory',
		},
		largeFixtureDir: {
			type: 'string',
			description: 'Generated large Claude fixture directory used as CLAUDE_CONFIG_DIR',
		},
		largeRuns: {
			type: 'number',
			default: 1,
			description: 'Measured hyperfine runs per command for the large fixture',
		},
		largeWarmup: {
			type: 'number',
			default: 0,
			description: 'Explicit warmup runs before each large-fixture command',
		},
		output: {
			type: 'string',
			description: 'Markdown output file path',
		},
		runs: {
			type: 'number',
			default: 7,
			description: 'Measured hyperfine runs per command',
		},
		warmup: {
			type: 'number',
			default: 2,
			description: 'Explicit warmup runs before each measured command',
		},
	},
	async run(ctx) {
		assertSampleOptions({ runs: ctx.values.runs, warmup: ctx.values.warmup }, '');
		assertSampleOptions({ runs: ctx.values.largeRuns, warmup: ctx.values.largeWarmup }, 'large-');

		const options = {
			baseDir: resolve(ctx.values.baseDir),
			fixtureDir: resolve(ctx.values.fixtureDir),
			headDir: resolve(ctx.values.headDir),
			runs: ctx.values.runs,
			warmup: ctx.values.warmup,
		};
		const sections = [
			await compareFixture({
				...options,
				commands: ['daily', 'session', 'blocks'],
				description:
					'Generated small fixture for stable Rust-vs-main feedback and output-shape regressions.',
				title: 'Small generated fixture performance',
			}),
		];
		if (ctx.values.largeFixtureDir != null) {
			sections.push(
				await compareFixture({
					...options,
					commands: ['daily'],
					description:
						'Generated fixture around 1 GiB shaped from aggregate local Claude-log statistics: thousands of JSONL files, many small sessions, and a long tail of larger sessions. No real prompts, paths, or outputs are stored in the fixture.',
					fixtureDir: resolve(ctx.values.largeFixtureDir),
					runs: ctx.values.largeRuns,
					title: 'Large real-world-shaped fixture performance',
					warmup: ctx.values.largeWarmup,
				}),
			);
		}

		const markdown = renderMarkdown(sections, options);
		if (ctx.values.output == null) {
			await Bun.write(Bun.stdout, markdown);
		} else {
			await Bun.write(resolve(ctx.values.output), markdown);
		}
	},
});

await cli(Bun.argv.slice(2), command, {
	name: 'compare-rust-pr-performance',
	description: 'Compare Rust ccusage PR performance against the JavaScript base branch',
	renderHeader: null,
});
