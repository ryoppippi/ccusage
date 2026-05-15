#!/usr/bin/env bun

import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { cli, define } from 'gunshi';
import { measure } from 'mitata';

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

function distDir(repoDir: string): string {
	return join(repoDir, 'apps', 'ccusage', 'dist');
}

function builtEntry(repoDir: string): string {
	return join(distDir(repoDir), 'index.js');
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

async function runCcusage(repoDir: string, fixtureDir: string, command: string): Promise<void> {
	const output = await Bun.$`pnpm exec bun -b ${builtEntry(repoDir)} ${command} --offline --json`
		.cwd(repoDir)
		.env({
			...Bun.env,
			CLAUDE_CONFIG_DIR: fixtureDir,
			COLUMNS: '200',
			LOG_LEVEL: '0',
			NO_COLOR: '1',
			TZ: 'UTC',
		})
		.nothrow()
		.quiet();

	if (output.exitCode !== 0) {
		const relativeLabel = relative(process.cwd(), repoDir);
		const label = relativeLabel.length === 0 ? repoDir : relativeLabel;
		const trimmedStderr = output.stderr.toString().trim();
		throw new Error(
			`${label} ${command} failed: ${
				trimmedStderr.length === 0 ? `exit ${output.exitCode}` : trimmedStderr
			}`,
		);
	}
}

async function measureCommand(
	repoDir: string,
	fixtureDir: string,
	command: string,
	options: { runs: number; warmup: number },
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
	options: {
		baseDir: string;
		fixtureDir: string;
		headDir: string;
		runs: number;
		warmup: number;
	},
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
	options: { fixtureDir: string; headDir: string; runs: number; warmup: number },
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
		'| Package | Base | PR | Delta | Ratio |',
		'| --- | ---: | ---: | ---: | ---: |',
		`| packed \`ccusage-*.tgz\` | ${formatSize(sizes.base)} | ${formatSize(sizes.head)} | ${sizeDelta >= 0 ? '+' : ''}${formatSize(sizeDelta)} | ${sizeRatio.toFixed(2)}x |`,
		'',
		'Lower medians and smaller packed package sizes are better. CI runner noise still applies; use same-run ratios as directional PR feedback, not release guarantees.',
		'',
	);

	return `${lines.join('\n')}\n`;
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
			description: 'Measured mitata samples per command',
		},
		warmup: {
			type: 'number',
			default: 2,
			description: 'Explicit warmup runs before each measured command',
		},
	},
	async run(ctx) {
		if (!Number.isInteger(ctx.values.runs) || ctx.values.runs < 1) {
			throw new Error('--runs must be a positive integer');
		}
		if (!Number.isInteger(ctx.values.warmup) || ctx.values.warmup < 0) {
			throw new Error('--warmup must be a non-negative integer');
		}

		const options = {
			baseDir: resolve(ctx.values.baseDir),
			fixtureDir: resolve(ctx.values.fixtureDir),
			headDir: resolve(ctx.values.headDir),
			runs: ctx.values.runs,
			warmup: ctx.values.warmup,
		};
		const commands = ['daily', 'session', 'blocks'];

		const results: CommandResult[] = [];
		for (const command of commands) {
			results.push(await compareCommand(command, options));
		}

		const sizes = {
			base: await packedTarballSizeBytes(options.baseDir),
			head: await packedTarballSizeBytes(options.headDir),
		};

		const markdown = renderMarkdown(results, sizes, options);
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
