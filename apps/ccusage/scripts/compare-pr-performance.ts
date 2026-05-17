#!/usr/bin/env bun

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execPath } from 'node:process';
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

type SizeComparison = {
	base: number;
	head: number;
};

type SampleOptions = {
	runs: number;
	warmup: number;
};

type FixtureComparison = SampleOptions & {
	codexFixtureDir?: string;
	codexFixtureStats?: FixtureStats;
	description: string;
	fixtureDir: string;
	fixtureStats: FixtureStats;
	results: CommandResult[];
	title: string;
};

type FixtureStats = {
	bytes: number;
	files: number;
};

type HyperfineResult = {
	command: string;
	max: number;
	median: number;
	min: number;
	times: number[];
};

type HyperfineExport = {
	results: HyperfineResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function ccusageBinPath(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const binPath = value.ccusage;
	return typeof binPath === 'string' ? binPath : undefined;
}

/**
 * Resolves the package entry that users get through the published `ccusage` bin.
 *
 * Source checkouts keep `bin` pointed at TypeScript for development, while publish rewrites through
 * `publishConfig.bin`. Benchmarks should follow that publish-facing entry so base and PR numbers
 * reflect the command users actually run.
 */
async function packageBinEntry(repoDir: string): Promise<string> {
	const packageDir = join(repoDir, 'apps', 'ccusage');
	const packageJson: unknown = await Bun.file(join(packageDir, 'package.json')).json();
	if (!isRecord(packageJson)) {
		throw new Error(`Invalid package.json in ${packageDir}`);
	}
	const publishConfig = packageJson.publishConfig;
	const publishBin = isRecord(publishConfig) ? ccusageBinPath(publishConfig.bin) : undefined;
	const binPath = publishBin ?? ccusageBinPath(packageJson.bin);
	if (binPath == null) {
		throw new Error(`ccusage bin is missing in ${packageDir}/package.json`);
	}
	return join(packageDir, binPath);
}

/**
 * Returns the size of the package artifact that would be published for ccusage.
 *
 * Raw `dist/` size is misleading now that sourcemaps are generated for local debugging but
 * excluded from `package.json#files`. `pnpm pack` applies the same prepack and files filtering as
 * publish, so the PR comment reports the artifact users would actually download. The original
 * package.json is restored because the prepack pipeline intentionally rewrites it for publish.
 */
async function packedTarballSizeBytes(repoDir: string): Promise<number> {
	const packageDir = join(repoDir, 'apps', 'ccusage');
	const packageJsonPath = join(packageDir, 'package.json');
	const originalPackageJson = await Bun.file(packageJsonPath).text();
	await using fixture = await createFixture({});
	try {
		const output = await Bun.$`pnpm pack --json --pack-destination ${fixture.path}`
			.cwd(packageDir)
			.nothrow()
			.quiet();
		if (output.exitCode !== 0) {
			const trimmedStderr = output.stderr.toString().trim();
			const trimmedStdout = output.stdout.toString().trim();
			const message =
				trimmedStderr.length > 0
					? trimmedStderr
					: trimmedStdout.length > 0
						? trimmedStdout
						: `exit ${output.exitCode}`;
			throw new Error(`pnpm pack failed: ${message}`);
		}
		const packResult = parsePnpmPackJson(output.stdout.toString());
		const filename = packResult.filename;
		if (filename == null) {
			throw new Error('pnpm pack did not report a tarball filename');
		}
		return Bun.file(filename).size;
	} finally {
		await Bun.write(packageJsonPath, originalPackageJson);
	}
}

/**
 * Reads the tarball path from `pnpm pack --json` output.
 *
 * `pnpm pack` can print lifecycle logs before its final JSON object because this
 * package runs a prepack build. The perf comment needs the publish artifact size,
 * so it intentionally parses the last JSON object instead of treating stdout as
 * a single clean JSON document.
 */
function parsePnpmPackJson(stdout: string): { filename: string } {
	const trimmed = stdout.trim();
	const start = trimmed.lastIndexOf('\n{');
	const jsonText = start === -1 ? trimmed : trimmed.slice(start + 1);
	return JSON.parse(jsonText) as { filename: string };
}

function formatDuration(milliseconds: number): string {
	return milliseconds >= 1000
		? `${(milliseconds / 1000).toFixed(3)}s`
		: `${milliseconds.toFixed(1)}ms`;
}

function formatSize(bytes: number): string {
	return `${(bytes / 1024).toFixed(2)} KiB`;
}

function formatDataSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatThroughput(bytes: number, milliseconds: number): string {
	const mibPerSecond = bytes / 1024 / 1024 / (milliseconds / 1000);
	return mibPerSecond >= 1024
		? `${(mibPerSecond / 1024).toFixed(2)} GiB/s`
		: `${mibPerSecond.toFixed(2)} MiB/s`;
}

async function summarizeDirectory(directory: string): Promise<FixtureStats> {
	let bytes = 0;
	let files = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			const child = await summarizeDirectory(entryPath);
			bytes += child.bytes;
			files += child.files;
			continue;
		}
		if (entry.isFile()) {
			const entryStat = await stat(entryPath);
			bytes += entryStat.size;
			files++;
		}
	}
	return { bytes, files };
}

async function writeProgress(message: string): Promise<void> {
	await Bun.write(Bun.stderr, `[ccusage-perf] ${message}\n`);
}

/**
 * Builds the ccusage command that hyperfine will benchmark.
 *
 * The CI script itself is launched through `pnpm exec bun`, but the benchmarked command resolves
 * the package's published bin and runs it with the Bun executable that is already executing this
 * script. Hyperfine runs this with `--shell none`, so the command is split into argv without shell
 * interpretation or hand-written shell quoting.
 */
export function createCcusageCommandFromBin(
	binEntry: string,
	fixtureDir: string,
	codexFixtureDir: string | undefined,
	command: string,
): string {
	return [
		'env',
		`CLAUDE_CONFIG_DIR=${fixtureDir}`,
		...(codexFixtureDir == null ? [] : [`CODEX_HOME=${codexFixtureDir}`]),
		'COLUMNS=200',
		'LOG_LEVEL=0',
		'NO_COLOR=1',
		'TZ=UTC',
		execPath,
		'-b',
		binEntry,
		command,
		'--offline',
		'--json',
	].join(' ');
}

export async function createCcusageCommand(
	repoDir: string,
	fixtureDir: string,
	codexFixtureDir: string | undefined,
	command: string,
): Promise<string> {
	return createCcusageCommandFromBin(
		await packageBinEntry(repoDir),
		fixtureDir,
		codexFixtureDir,
		command,
	);
}

/**
 * Converts hyperfine's seconds-based JSON result into the millisecond shape used by the PR
 * comment renderer.
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
		codexFixtureDir?: string;
		fixtureDir: string;
		headDir: string;
		runs: number;
		warmup: number;
	},
): Promise<CommandResult> {
	await writeProgress(`${options.fixtureTitle} / ${command} started`);
	await using fixture = await createFixture({});
	const exportPath = join(fixture.path, 'hyperfine.json');
	const baseCommand = await createCcusageCommand(
		options.baseDir,
		options.fixtureDir,
		options.codexFixtureDir,
		command,
	);
	const headCommand = await createCcusageCommand(
		options.headDir,
		options.fixtureDir,
		options.codexFixtureDir,
		command,
	);
	const hyperfine = Bun.spawn(
		[
			'hyperfine',
			'--shell',
			'none',
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
			'base',
			'--command-name',
			'PR',
			baseCommand,
			headCommand,
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
		throw new Error(`hyperfine did not report both base and PR results for ${command}`);
	}
	const base = measurementFromHyperfine(baseResult);
	const head = measurementFromHyperfine(headResult);
	await writeProgress(
		`${options.fixtureTitle} / ${command} done: base ${formatDuration(base.median)}, PR ${formatDuration(head.median)}`,
	);

	return {
		base,
		command,
		head,
	};
}

/**
 * Runs the selected command matrix for one fixture directory.
 *
 * Keeping this grouped by fixture lets the CI comment report the committed small fixture and the
 * generated 1 GiB real-world-shaped fixture separately. Those two workloads stress different
 * paths: the committed fixture is stable and quick, while the generated fixture catches
 * regressions in the multi-file loading path used by large Claude corpora. The large fixture
 * currently runs only `daily` because base-branch scans over 1 GiB are intentionally expensive.
 */
async function compareFixture(options: {
	baseDir: string;
	codexFixtureDir?: string;
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
	const [fixtureStats, codexStats] = await Promise.all([
		summarizeDirectory(options.fixtureDir),
		options.codexFixtureDir == null
			? Promise.resolve<FixtureStats | undefined>(undefined)
			: summarizeDirectory(options.codexFixtureDir),
	]);
	const codexFixtureStats = codexStats;
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
		codexFixtureDir: options.codexFixtureDir,
		codexFixtureStats,
		description: options.description,
		fixtureDir: options.fixtureDir,
		fixtureStats,
		results,
		runs: options.runs,
		title: options.title,
		warmup: options.warmup,
	};
}

/**
 * Keeps the PR comment path readable for committed fixtures while still showing
 * generated CI fixtures that live outside the repository checkout.
 */
function formatFixturePath(headDir: string, fixtureDir: string): string {
	const relativePath = relative(headDir, fixtureDir);
	return relativePath.startsWith('..') ? fixtureDir : relativePath;
}

function formatFixtureStats(stats: FixtureStats): string {
	return `${formatDataSize(stats.bytes)}, ${stats.files.toLocaleString('en-US')} files`;
}

function fixtureStatsForCommand(section: FixtureComparison, command: string): FixtureStats {
	if (command.startsWith('codex') && section.codexFixtureStats != null) {
		return section.codexFixtureStats;
	}
	return section.fixtureStats;
}

/**
 * Renders one benchmark table so additional fixture workloads can be appended without duplicating
 * markdown layout logic or accidentally dropping the base/head speedup column.
 */
export function renderFixtureSection(
	section: FixtureComparison,
	options: { headDir: string },
): string[] {
	const lines = [
		`## ${section.title}`,
		'',
		section.description,
		'',
		section.codexFixtureDir == null
			? `Fixture: \`${formatFixturePath(options.headDir, section.fixtureDir)}\` (${formatFixtureStats(section.fixtureStats)})`
			: `Fixtures: Claude \`${formatFixturePath(options.headDir, section.fixtureDir)}\` (${formatFixtureStats(section.fixtureStats)}), Codex \`${formatFixturePath(options.headDir, section.codexFixtureDir)}\` (${formatFixtureStats(section.codexFixtureStats ?? section.fixtureStats)})`,
		`Runtime: package \`ccusage\` bin from \`apps/ccusage/package.json\` through \`bun -b\`, \`--offline --json\`, measured by \`hyperfine\` with \`${section.warmup}\` warmups and \`${section.runs}\` runs.`,
		'',
		'| Command | Input | Base median | PR median | PR vs base | Base throughput | PR throughput |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
	];

	for (const result of section.results) {
		const speedup = result.base.median / result.head.median;
		const fixtureStats = fixtureStatsForCommand(section, result.command);
		lines.push(
			`| \`${result.command} --offline --json\` | ${formatDataSize(fixtureStats.bytes)} | ${formatDuration(result.base.median)} | ${formatDuration(result.head.median)} | ${speedup.toFixed(2)}x | ${formatThroughput(fixtureStats.bytes, result.base.median)} | ${formatThroughput(fixtureStats.bytes, result.head.median)} |`,
		);
	}

	return lines;
}

function renderMarkdown(
	sections: FixtureComparison[],
	sizes: SizeComparison,
	options: { headDir: string },
): string {
	const lines = [
		'<!-- ccusage-perf-comment -->',
		'## ccusage performance comparison',
		'',
		'This compares the PR build against the base branch build on the same CI runner.',
		'',
	];

	for (const section of sections) {
		lines.push(...renderFixtureSection(section, options), '');
	}

	const sizeDelta = sizes.head - sizes.base;
	const sizeRatio = sizes.base / sizes.head;
	lines.push(
		'## Package size',
		'',
		'| Package artifact | Base | PR | Delta | Ratio |',
		'| --- | ---: | ---: | ---: | ---: |',
		`| packed \`ccusage-*.tgz\` | ${formatSize(sizes.base)} | ${formatSize(sizes.head)} | ${sizeDelta >= 0 ? '+' : ''}${formatSize(sizeDelta)} | ${sizeRatio.toFixed(2)}x |`,
		'',
		'Lower medians and smaller packed package sizes are better. CI runner noise still applies; use same-run ratios as directional PR feedback, not release guarantees.',
		'',
	);

	return `${lines.join('\n')}\n`;
}

if (import.meta.vitest != null) {
	describe('createCcusageCommandFromBin', () => {
		it('builds hyperfine command text that benchmarks the published ccusage bin with both Claude and Codex fixture environment variables', () => {
			const commandText = createCcusageCommandFromBin(
				'/repo/apps/ccusage/dist/cli.js',
				'/fixtures/claude',
				'/fixtures/codex',
				'codex session',
			);

			expect(commandText).toContain('CLAUDE_CONFIG_DIR=/fixtures/claude');
			expect(commandText).toContain('CODEX_HOME=/fixtures/codex');
			expect(commandText).toContain('codex session --offline --json');
		});
	});

	describe('renderFixtureSection', () => {
		it('renders fixture sizes and throughput so Claude and Codex timings are comparable', () => {
			const lines = renderFixtureSection(
				{
					codexFixtureDir: '/fixtures/codex',
					codexFixtureStats: {
						bytes: 512 * 1024 * 1024,
						files: 200,
					},
					description: 'Fixture description',
					fixtureDir: '/fixtures/claude',
					fixtureStats: {
						bytes: 1024 * 1024 * 1024,
						files: 400,
					},
					results: [
						{
							base: { max: 2000, median: 2000, min: 2000, samples: 1 },
							command: 'claude',
							head: { max: 1000, median: 1000, min: 1000, samples: 1 },
						},
						{
							base: { max: 1000, median: 1000, min: 1000, samples: 1 },
							command: 'codex',
							head: { max: 500, median: 500, min: 500, samples: 1 },
						},
					],
					runs: 1,
					title: 'Large fixture',
					warmup: 0,
				},
				{ headDir: '/repo' },
			);

			expect(lines.join('\n')).toContain('Claude `/fixtures/claude` (1.00 GiB, 400 files)');
			expect(lines.join('\n')).toContain('Codex `/fixtures/codex` (512.00 MiB, 200 files)');
			expect(lines.join('\n')).toContain('| `claude --offline --json` | 1.00 GiB |');
			expect(lines.join('\n')).toContain('| `codex --offline --json` | 512.00 MiB |');
			expect(lines.join('\n')).toContain('512.00 MiB/s');
			expect(lines.join('\n')).toContain('1.00 GiB/s');
		});
	});
}

/**
 * Rejects accidental zero-sample CI runs early so the PR comment cannot present an empty
 * benchmark as a successful comparison.
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
	name: 'compare-pr-performance',
	description: 'Compare ccusage fixture performance between two built repository directories',
	toKebab: true,
	args: {
		baseDir: {
			type: 'string',
			required: true,
			description: 'Base repository directory',
		},
		headDir: {
			type: 'string',
			required: true,
			description: 'PR/head repository directory',
		},
		fixtureDir: {
			type: 'string',
			required: true,
			description: 'Claude fixture directory used as CLAUDE_CONFIG_DIR',
		},
		codexFixtureDir: {
			type: 'string',
			required: true,
			description: 'Codex fixture directory used as CODEX_HOME',
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
		largeFixtureDir: {
			type: 'string',
			description: 'Generated large Claude fixture directory used as CLAUDE_CONFIG_DIR',
		},
		largeCodexFixtureDir: {
			type: 'string',
			description: 'Generated large Codex fixture directory used as CODEX_HOME',
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
	},
	async run(ctx) {
		assertSampleOptions({ runs: ctx.values.runs, warmup: ctx.values.warmup }, '');
		assertSampleOptions({ runs: ctx.values.largeRuns, warmup: ctx.values.largeWarmup }, 'large-');

		const options = {
			baseDir: resolve(ctx.values.baseDir),
			codexFixtureDir: resolve(ctx.values.codexFixtureDir),
			fixtureDir: resolve(ctx.values.fixtureDir),
			headDir: resolve(ctx.values.headDir),
			runs: ctx.values.runs,
			warmup: ctx.values.warmup,
		};
		const sections = [
			await compareFixture({
				...options,
				commands: ['claude daily', 'claude session', 'codex daily', 'codex session'],
				description:
					'Committed small fixtures for stable PR-to-PR feedback and explicit Claude/Codex command coverage.',
				title: 'Committed fixture performance',
			}),
		];
		if (ctx.values.largeFixtureDir != null) {
			sections.push(
				await compareFixture({
					...options,
					codexFixtureDir:
						ctx.values.largeCodexFixtureDir == null
							? options.codexFixtureDir
							: resolve(ctx.values.largeCodexFixtureDir),
					commands: ['claude', 'codex'],
					description:
						'Generated fixtures shaped from aggregate local log statistics: thousands of JSONL files, many small sessions, and a long tail of larger sessions. No real prompts, paths, or outputs are stored in the fixtures.',
					fixtureDir: resolve(ctx.values.largeFixtureDir),
					runs: ctx.values.largeRuns,
					title: 'Large real-world-shaped fixture performance',
					warmup: ctx.values.largeWarmup,
				}),
			);
		}

		const sizes = {
			base: await packedTarballSizeBytes(options.baseDir),
			head: await packedTarballSizeBytes(options.headDir),
		};

		const markdown = renderMarkdown(sections, sizes, options);
		if (ctx.values.output == null) {
			await Bun.write(Bun.stdout, markdown);
		} else {
			await Bun.write(resolve(ctx.values.output), markdown);
		}
	},
});

if (import.meta.main) {
	await cli(Bun.argv.slice(2), command, {
		name: 'compare-pr-performance',
		description: 'Compare ccusage fixture performance between two built repository directories',
		renderHeader: null,
	});
}
