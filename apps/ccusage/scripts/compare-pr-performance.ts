#!/usr/bin/env bun

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
	description: string;
	fixtureDir: string;
	results: CommandResult[];
	title: string;
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
async function createCcusageCommand(
	repoDir: string,
	fixtureDir: string,
	command: string,
): Promise<string> {
	return [
		'env',
		`CLAUDE_CONFIG_DIR=${fixtureDir}`,
		'COLUMNS=200',
		'LOG_LEVEL=0',
		'NO_COLOR=1',
		'TZ=UTC',
		execPath,
		'-b',
		await packageBinEntry(repoDir),
		command,
		'--offline',
		'--json',
	].join(' ');
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
		fixtureDir: string;
		headDir: string;
		runs: number;
		warmup: number;
	},
): Promise<CommandResult> {
	await writeProgress(`${options.fixtureTitle} / ${command} started`);
	await using fixture = await createFixture({});
	const exportPath = join(fixture.path, 'hyperfine.json');
	const baseCommand = await createCcusageCommand(options.baseDir, options.fixtureDir, command);
	const headCommand = await createCcusageCommand(options.headDir, options.fixtureDir, command);
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
 * Keeps the PR comment path readable for committed fixtures while still showing
 * generated CI fixtures that live outside the repository checkout.
 */
function formatFixturePath(headDir: string, fixtureDir: string): string {
	const relativePath = relative(headDir, fixtureDir);
	return relativePath.startsWith('..') ? fixtureDir : relativePath;
}

/**
 * Renders one benchmark table so additional fixture workloads can be appended without duplicating
 * markdown layout logic or accidentally dropping the base/head speedup column.
 */
function renderFixtureSection(section: FixtureComparison, options: { headDir: string }): string[] {
	const lines = [
		`## ${section.title}`,
		'',
		section.description,
		'',
		`Fixture: \`${formatFixturePath(options.headDir, section.fixtureDir)}\``,
		`Runtime: package \`ccusage\` bin from \`apps/ccusage/package.json\` through \`bun -b\`, \`--offline --json\`, measured by \`hyperfine\` with \`${section.warmup}\` warmups and \`${section.runs}\` runs.`,
		'',
		'| Command | Base median | PR median | PR vs base |',
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
					'Committed small fixture for stable PR-to-PR feedback and output-shape regressions.',
				title: 'Committed fixture performance',
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

await cli(Bun.argv.slice(2), command, {
	name: 'compare-pr-performance',
	description: 'Compare ccusage fixture performance between two built repository directories',
	renderHeader: null,
});
