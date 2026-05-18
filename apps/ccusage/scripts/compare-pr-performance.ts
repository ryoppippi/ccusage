#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process, { execPath, platform } from 'node:process';
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
	basePackage: number;
	baseRustBinary?: number;
	headPackage: number;
	headRustBinary?: number;
};

type PackageRunnerMeasurement = {
	acquisition?: number;
	cold: number;
	packageUrl: string;
	warm: CommandMeasurement;
};

type PackageRunnerComparison = {
	base?: PackageRunnerMeasurement;
	head?: PackageRunnerMeasurement;
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

type HeadRuntime = 'package' | 'rust';
const headRuntimeChoices = ['package', 'rust'] as const satisfies readonly HeadRuntime[];

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

function rustBinaryEntry(repoDir: string): string {
	return join(
		repoDir,
		'rust',
		'target',
		'release',
		platform === 'win32' ? 'ccusage.exe' : 'ccusage',
	);
}

function packageBinShim(installDir: string): string {
	return join(installDir, 'node_modules', '.bin', platform === 'win32' ? 'ccusage.cmd' : 'ccusage');
}

async function installedPackageBinEntry(installDir: string): Promise<string> {
	const packageDir = join(installDir, 'node_modules', 'ccusage');
	const packageJson = JSON.parse(
		await readFile(join(packageDir, 'package.json'), 'utf8'),
	) as unknown;
	if (!isRecord(packageJson)) {
		return packageBinShim(installDir);
	}
	const binPath = ccusageBinPath(packageJson.bin);
	return binPath == null ? packageBinShim(installDir) : join(packageDir, binPath);
}

function parseHeadRuntime(value: string | undefined): HeadRuntime {
	if (value === 'package' || value === 'rust') {
		return value;
	}
	throw new Error(`Invalid head runtime: ${value ?? ''}. Use package or rust.`);
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

async function remoteTarballSizeBytes(packageUrl: string): Promise<number> {
	const response = await fetch(packageUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${packageUrl}: HTTP ${response.status}`);
	}
	return (await response.arrayBuffer()).byteLength;
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

function formatOptionalSize(bytes: number | undefined): string {
	return bytes == null ? '-' : formatSize(bytes);
}

function formatSizeDelta(baseBytes: number | undefined, headBytes: number | undefined): string {
	if (baseBytes == null || headBytes == null) {
		return '-';
	}
	const delta = headBytes - baseBytes;
	return `${delta >= 0 ? '+' : ''}${formatSize(delta)}`;
}

function formatSizeRatio(baseBytes: number | undefined, headBytes: number | undefined): string {
	if (baseBytes == null || headBytes == null || headBytes === 0) {
		return '-';
	}
	return `${(baseBytes / headBytes).toFixed(2)}x`;
}

function formatDataSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function measurementFromMilliseconds(times: number[]): CommandMeasurement {
	if (times.length === 0) {
		throw new Error('Cannot summarize zero measurements');
	}
	const sorted = [...times].sort((a, b) => a - b);
	return {
		max: sorted.at(-1) ?? sorted[0]!,
		median: sorted[Math.floor(sorted.length / 2)]!,
		min: sorted[0]!,
		samples: sorted.length,
	};
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

async function optionalFileSizeBytes(filePath: string): Promise<number | undefined> {
	try {
		const fileStat = await stat(filePath);
		return fileStat.isFile() ? fileStat.size : undefined;
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

async function installPackageUrl({
	installDir,
	label,
	packageUrl,
	timeoutMs,
}: {
	installDir: string;
	label: string;
	packageUrl: string;
	timeoutMs: number;
}): Promise<{ acquisition: number; binEntry: string }> {
	await writeProgress(`${label} package install waiting for package URL`);
	if (!(await waitForPackageUrl(packageUrl, timeoutMs))) {
		throw new Error(`${label} package URL was not ready: ${packageUrl}`);
	}
	await mkdir(installDir, { recursive: true });
	await Bun.write(
		join(installDir, 'package.json'),
		JSON.stringify({ dependencies: { ccusage: packageUrl }, private: true }, null, 2),
	);
	await writeProgress(`${label} package install started: ${packageUrl}`);
	const startedAt = performance.now();
	const install = Bun.spawn([execPath, 'install', '--no-progress'], {
		cwd: installDir,
		stderr: 'pipe',
		stdout: 'pipe',
	});
	const exitCode = await install.exited;
	const acquisition = performance.now() - startedAt;
	if (exitCode !== 0) {
		const stderr = await new Response(install.stderr).text();
		const stdout = await new Response(install.stdout).text();
		const trimmedStderr = stderr.trim();
		const trimmedStdout = stdout.trim();
		throw new Error(
			`${label} package install failed: ${trimmedStderr.length > 0 ? trimmedStderr : trimmedStdout.length > 0 ? trimmedStdout : `exit ${exitCode}`}`,
		);
	}
	await writeProgress(`${label} package install finished: ${formatDuration(acquisition)}`);
	return {
		acquisition,
		binEntry: await installedPackageBinEntry(installDir),
	};
}

async function packageUrlIsReady(packageUrl: string): Promise<boolean> {
	const response = await fetch(packageUrl, { method: 'HEAD' });
	return response.ok;
}

async function waitForPackageUrl(packageUrl: string, timeoutMs: number): Promise<boolean> {
	const startedAt = performance.now();
	while (performance.now() - startedAt < timeoutMs) {
		if (await packageUrlIsReady(packageUrl)) {
			return true;
		}
		await Bun.sleep(5000);
	}
	return false;
}

async function writeProgress(message: string): Promise<void> {
	await Bun.write(Bun.stderr, `[ccusage-perf] ${message}\n`);
}

function gitSha(directory: string): string {
	return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
	}).trim();
}

function formatSha(sha: string): string {
	return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function packageUrlSha(packageUrl: string): string {
	const match = packageUrl.match(/@([0-9a-f]{7,40})(?:$|[/?#])/i);
	return match == null ? packageUrl : formatSha(match[1]!);
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

export function createCcusageCommandFromRustBinary(
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
		binEntry,
		command,
		'--offline',
		'--json',
	].join(' ');
}

function createBunxStartupCommand(packageUrl: string): string[] {
	return [execPath, 'x', '-p', packageUrl, 'ccusage', '--version'];
}

async function measureCommandMilliseconds({
	args,
	env,
	label,
}: {
	args: string[];
	env: Record<string, string>;
	label: string;
}): Promise<number> {
	const startedAt = performance.now();
	const child = Bun.spawn(args, {
		env: {
			...process.env,
			...env,
		},
		stderr: 'pipe',
		stdout: 'ignore',
	});
	const exitCode = await child.exited;
	const elapsed = performance.now() - startedAt;
	if (exitCode !== 0) {
		throw new Error(`${label} failed: ${await new Response(child.stderr).text()}`);
	}
	return elapsed;
}

async function measurePackageRunnerStartup({
	cacheDir,
	label,
	packageUrl,
	runs,
	timeoutMs,
}: {
	cacheDir: string;
	label: string;
	packageUrl: string;
	runs: number;
	timeoutMs: number;
}): Promise<PackageRunnerMeasurement | undefined> {
	await writeProgress(`${label} bunx startup waiting for package URL`);
	if (!(await waitForPackageUrl(packageUrl, timeoutMs))) {
		await writeProgress(`${label} bunx startup skipped because package URL was not ready`);
		return undefined;
	}

	const args = createBunxStartupCommand(packageUrl);
	const env = { BUN_INSTALL_CACHE_DIR: cacheDir };
	await writeProgress(`${label} bunx cold startup started`);
	const cold = await measureCommandMilliseconds({
		args,
		env,
		label: `${label} bunx cold startup`,
	});
	const warmTimes: number[] = [];
	for (let index = 0; index < runs; index++) {
		warmTimes.push(
			await measureCommandMilliseconds({
				args,
				env,
				label: `${label} bunx warm startup`,
			}),
		);
	}
	const warm = measurementFromMilliseconds(warmTimes);
	await writeProgress(
		`${label} bunx startup done: cold ${formatDuration(cold)}, warm ${formatDuration(warm.median)}`,
	);
	return {
		cold,
		packageUrl,
		warm,
	};
}

async function measurePackageRunnerWithAcquisition({
	acquisition,
	cacheDir,
	label,
	packageUrl,
	runs,
	timeoutMs,
}: {
	acquisition?: number;
	cacheDir: string;
	label: string;
	packageUrl: string;
	runs: number;
	timeoutMs: number;
}): Promise<PackageRunnerMeasurement | undefined> {
	const startup = await measurePackageRunnerStartup({
		cacheDir,
		label,
		packageUrl,
		runs,
		timeoutMs,
	});
	return startup == null
		? undefined
		: {
				...startup,
				acquisition,
			};
}

export async function createCcusageCommand(
	repoDir: string,
	fixtureDir: string,
	codexFixtureDir: string | undefined,
	command: string,
	runtime: HeadRuntime = 'package',
): Promise<string> {
	if (runtime === 'rust') {
		return createCcusageCommandFromRustBinary(
			rustBinaryEntry(repoDir),
			fixtureDir,
			codexFixtureDir,
			command,
		);
	}
	return createCcusageCommandFromBin(
		await packageBinEntry(repoDir),
		fixtureDir,
		codexFixtureDir,
		command,
	);
}

export async function createHeadCcusageCommand(options: {
	command: string;
	codexFixtureDir?: string;
	fixtureDir: string;
	headBinEntry?: string;
	headDir: string;
	headRuntime: HeadRuntime;
}): Promise<string> {
	if (options.headRuntime === 'package' && options.headBinEntry != null) {
		return createCcusageCommandFromBin(
			options.headBinEntry,
			options.fixtureDir,
			options.codexFixtureDir,
			options.command,
		);
	}
	return createCcusageCommand(
		options.headDir,
		options.fixtureDir,
		options.codexFixtureDir,
		options.command,
		options.headRuntime,
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
		baseBinEntry: string;
		fixtureTitle: string;
		codexFixtureDir?: string;
		fixtureDir: string;
		headBinEntry?: string;
		headDir: string;
		headRuntime: HeadRuntime;
		runs: number;
		warmup: number;
	},
): Promise<CommandResult> {
	await writeProgress(`${options.fixtureTitle} / ${command} started`);
	await using fixture = await createFixture({});
	const exportPath = join(fixture.path, 'hyperfine.json');
	const baseCommand = createCcusageCommandFromBin(
		options.baseBinEntry,
		options.fixtureDir,
		options.codexFixtureDir,
		command,
	);
	const headCommand = await createHeadCcusageCommand({
		command,
		codexFixtureDir: options.codexFixtureDir,
		fixtureDir: options.fixtureDir,
		headBinEntry: options.headBinEntry,
		headDir: options.headDir,
		headRuntime: options.headRuntime,
	});
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
	baseBinEntry: string;
	codexFixtureDir?: string;
	commands: string[];
	description: string;
	fixtureDir: string;
	headBinEntry?: string;
	headDir: string;
	headRuntime: HeadRuntime;
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
	options: {
		baseRuntimeDescription?: string;
		headDir: string;
		headRuntime: HeadRuntime;
		headRuntimeDescription?: string;
	},
): string[] {
	const baseRuntimeDescription =
		options.baseRuntimeDescription ??
		'Base runs the package `ccusage` bin from `apps/ccusage/package.json` through `bun -b`';
	const headRuntimeDescription =
		options.headRuntimeDescription ??
		(options.headRuntime === 'rust'
			? 'PR runs `rust/target/release/ccusage` directly'
			: 'PR runs the package `ccusage` bin from `apps/ccusage/package.json` through `bun -b`');
	const runtimeText = `${baseRuntimeDescription}; ${headRuntimeDescription}.`;
	const lines = [
		`## ${section.title}`,
		'',
		section.description,
		'',
		section.codexFixtureDir == null
			? `Fixture: \`${formatFixturePath(options.headDir, section.fixtureDir)}\` (${formatFixtureStats(section.fixtureStats)})`
			: `Fixtures: Claude \`${formatFixturePath(options.headDir, section.fixtureDir)}\` (${formatFixtureStats(section.fixtureStats)}), Codex \`${formatFixturePath(options.headDir, section.codexFixtureDir)}\` (${formatFixtureStats(section.codexFixtureStats ?? section.fixtureStats)})`,
		`${runtimeText} Both run \`--offline --json\`, measured by \`hyperfine\` with \`${section.warmup}\` warmups and \`${section.runs}\` runs.`,
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

function renderPackageRunnerComparison(
	packageRunner: PackageRunnerComparison | undefined,
): string[] {
	if (packageRunner?.base == null && packageRunner?.head == null) {
		return [];
	}

	const lines = [
		'## Package runner startup',
		'',
		'Execution setup measures any pre-benchmark package materialization used by the execution benchmark. Bunx temp cache measures one `bunx -p <url> ccusage --version` run with an empty Bun install cache. Warm reuses that cache and reports the median of repeated runs.',
		'',
		'| Package | SHA | Execution setup | Bunx temp cache | Bunx warm median | Warm samples |',
		'| --- | ---: | ---: | ---: | ---: | ---: |',
	];

	if (packageRunner.base != null) {
		lines.push(
			`| Base pkg.pr.new | \`${packageUrlSha(packageRunner.base.packageUrl)}\` | ${packageRunner.base.acquisition == null ? '-' : formatDuration(packageRunner.base.acquisition)} | ${formatDuration(packageRunner.base.cold)} | ${formatDuration(packageRunner.base.warm.median)} | ${packageRunner.base.warm.samples} |`,
		);
	}
	if (packageRunner.head != null) {
		lines.push(
			`| PR pkg.pr.new | \`${packageUrlSha(packageRunner.head.packageUrl)}\` | ${packageRunner.head.acquisition == null ? '-' : formatDuration(packageRunner.head.acquisition)} | ${formatDuration(packageRunner.head.cold)} | ${formatDuration(packageRunner.head.warm.median)} | ${packageRunner.head.warm.samples} |`,
		);
	}

	return [...lines, ''];
}

function renderMarkdown(
	sections: FixtureComparison[],
	sizes: SizeComparison,
	options: {
		baseRuntimeDescription?: string;
		baseSha?: string;
		headDir: string;
		headRuntime: HeadRuntime;
		headRuntimeDescription?: string;
		headSha?: string;
		packageRunner?: PackageRunnerComparison;
	},
): string {
	const markerName =
		options.headRuntime === 'rust' ? 'ccusage-rust-perf-comment' : 'ccusage-perf-comment';
	const commentMarker = `<!-- ${markerName} -->`;
	const lines = [
		commentMarker,
		...(options.headSha == null ? [] : [`<!-- ${markerName}:${options.headSha} -->`]),
		'## ccusage performance comparison',
		'',
		...(options.headSha == null
			? []
			: [
					`PR SHA: \`${formatSha(options.headSha)}\``,
					...(options.baseSha == null ? [] : [`Base SHA: \`${formatSha(options.baseSha)}\``]),
					'',
				]),
		options.headRuntime === 'rust'
			? 'This compares the Rust PR release binary against the configured base package on the same CI runner.'
			: 'This compares the PR package against the configured base package on the same CI runner.',
		'',
	];

	lines.push(...renderPackageRunnerComparison(options.packageRunner));

	for (const section of sections) {
		lines.push(...renderFixtureSection(section, options), '');
	}

	lines.push(
		'## Artifact size',
		'',
		'| Artifact | Base | PR | Delta | Ratio |',
		'| --- | ---: | ---: | ---: | ---: |',
		`| packed \`ccusage-*.tgz\` | ${formatSize(sizes.basePackage)} | ${formatSize(sizes.headPackage)} | ${formatSizeDelta(sizes.basePackage, sizes.headPackage)} | ${formatSizeRatio(sizes.basePackage, sizes.headPackage)} |`,
		...(sizes.headRustBinary == null
			? []
			: [
					`| Rust release binary \`rust/target/release/ccusage\` | ${formatOptionalSize(sizes.baseRustBinary)} | ${formatSize(sizes.headRustBinary)} | ${formatSizeDelta(sizes.baseRustBinary, sizes.headRustBinary)} | ${formatSizeRatio(sizes.baseRustBinary, sizes.headRustBinary)} |`,
				]),
		'',
		'Lower medians and smaller artifacts are better. CI runner noise still applies; use same-run ratios as directional PR feedback, not release guarantees.',
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

		it('builds hyperfine command text for the Rust release binary with both Claude and Codex fixture environment variables', () => {
			const commandText = createCcusageCommandFromRustBinary(
				'/repo/rust/target/release/ccusage',
				'/fixtures/claude',
				'/fixtures/codex',
				'codex session',
			);

			expect(commandText).toContain('CLAUDE_CONFIG_DIR=/fixtures/claude');
			expect(commandText).toContain('CODEX_HOME=/fixtures/codex');
			expect(commandText).toContain(
				'/repo/rust/target/release/ccusage codex session --offline --json',
			);
			expect(commandText).not.toContain(' -b ');
		});
	});

	describe('createHeadCcusageCommand', () => {
		it('resolves the installed package published bin instead of the package manager shim', async () => {
			await using fixture = await createFixture({});
			const packageDir = join(fixture.path, 'node_modules', 'ccusage');
			await mkdir(packageDir, { recursive: true });
			await writeFile(
				join(packageDir, 'package.json'),
				JSON.stringify({
					bin: {
						ccusage: './dist/cli.js',
					},
				}),
			);

			await expect(installedPackageBinEntry(fixture.path)).resolves.toBe(
				join(packageDir, './dist/cli.js'),
			);
		});

		it('uses the installed PR pkg.pr.new bin for package runtime benchmarks when one is available', async () => {
			const commandText = await createHeadCcusageCommand({
				codexFixtureDir: '/fixtures/codex',
				command: 'claude',
				fixtureDir: '/fixtures/claude',
				headBinEntry: '/tmp/head-package/node_modules/ccusage/dist/cli.js',
				headDir: '/repo',
				headRuntime: 'package',
			});

			expect(commandText).toContain('/tmp/head-package/node_modules/ccusage/dist/cli.js');
			expect(commandText).not.toContain('/repo/apps/ccusage');
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
				{ headDir: '/repo', headRuntime: 'package' },
			);

			expect(lines.join('\n')).toContain('Claude `/fixtures/claude` (1.00 GiB, 400 files)');
			expect(lines.join('\n')).toContain('Codex `/fixtures/codex` (512.00 MiB, 200 files)');
			expect(lines.join('\n')).toContain('| `claude --offline --json` | 1.00 GiB |');
			expect(lines.join('\n')).toContain('| `codex --offline --json` | 512.00 MiB |');
			expect(lines.join('\n')).toContain('512.00 MiB/s');
			expect(lines.join('\n')).toContain('1.00 GiB/s');
		});

		it('describes the Rust PR runtime when the head benchmark uses the native binary', () => {
			const lines = renderFixtureSection(
				{
					description: 'Fixture description',
					fixtureDir: '/fixtures/claude',
					fixtureStats: {
						bytes: 1024,
						files: 1,
					},
					results: [],
					runs: 1,
					title: 'Rust fixture',
					warmup: 0,
				},
				{ baseRuntimeDescription: 'Base runs pkg.pr.new', headDir: '/repo', headRuntime: 'rust' },
			);

			expect(lines.join('\n')).toContain(
				'Base runs pkg.pr.new; PR runs `rust/target/release/ccusage` directly.',
			);
		});

		it('describes the PR pkg.pr.new runtime when package benchmarks use the preview package', () => {
			const lines = renderFixtureSection(
				{
					description: 'Fixture description',
					fixtureDir: '/fixtures/claude',
					fixtureStats: {
						bytes: 1024,
						files: 1,
					},
					results: [],
					runs: 1,
					title: 'Package fixture',
					warmup: 0,
				},
				{
					baseRuntimeDescription: 'Base runs pkg.pr.new',
					headDir: '/repo',
					headRuntime: 'package',
					headRuntimeDescription: 'PR runs pkg.pr.new',
				},
			);

			expect(lines.join('\n')).toContain('Base runs pkg.pr.new; PR runs pkg.pr.new.');
		});
	});

	describe('renderPackageRunnerComparison', () => {
		it('renders cold and warm bunx startup timings separately from execution benchmarks', () => {
			const markdown = renderPackageRunnerComparison({
				base: {
					acquisition: 400,
					cold: 1200,
					packageUrl: 'https://pkg.pr.new/ryoppippi/ccusage/ccusage@0123456789abcdef',
					warm: {
						max: 100,
						median: 90,
						min: 80,
						samples: 3,
					},
				},
			}).join('\n');

			expect(markdown).toContain('## Package runner startup');
			expect(markdown).toContain('Bunx temp cache measures one');
			expect(markdown).toContain(
				'| Package | SHA | Execution setup | Bunx temp cache | Bunx warm median | Warm samples |',
			);
			expect(markdown).toContain(
				'| Base pkg.pr.new | `0123456789ab` | 400.0ms | 1.200s | 90.0ms | 3 |',
			);
		});
	});

	describe('renderMarkdown', () => {
		const emptyFixtureSection = {
			description: 'Fixture description',
			fixtureDir: '/fixtures/claude',
			fixtureStats: {
				bytes: 1024,
				files: 1,
			},
			results: [],
			runs: 1,
			title: 'Fixture',
			warmup: 0,
		} satisfies FixtureComparison;

		const sizes = {
			basePackage: 1024,
			headPackage: 1024,
		} satisfies SizeComparison;

		it('uses the Rust-specific PR comment marker for native benchmark output', () => {
			const markdown = renderMarkdown([emptyFixtureSection], sizes, {
				headDir: '/repo',
				headRuntime: 'rust',
			});

			expect(markdown.startsWith('<!-- ccusage-rust-perf-comment -->')).toBe(true);
		});

		it('includes commit-specific markers and visible SHAs', () => {
			const markdown = renderMarkdown([emptyFixtureSection], sizes, {
				baseSha: '0123456789abcdef',
				headDir: '/repo',
				headRuntime: 'rust',
				headSha: 'abcdef0123456789',
			});

			expect(markdown).toContain('<!-- ccusage-rust-perf-comment:abcdef0123456789 -->');
			expect(markdown).toContain('PR SHA: `abcdef012345`');
			expect(markdown).toContain('Base SHA: `0123456789ab`');
		});

		it('compares Rust release binary sizes when both revisions provide them', () => {
			const markdown = renderMarkdown(
				[emptyFixtureSection],
				{
					basePackage: 1024,
					baseRustBinary: 2 * 1024,
					headPackage: 1024,
					headRustBinary: 1024,
				},
				{
					headDir: '/repo',
					headRuntime: 'rust',
				},
			);

			expect(markdown).toContain(
				'| Rust release binary `rust/target/release/ccusage` | 2.00 KiB | 1.00 KiB | -1.00 KiB | 2.00x |',
			);
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
			description: 'Base repository directory',
		},
		basePackageUrl: {
			type: 'string',
			description: 'Base pkg.pr.new ccusage package URL to install before benchmarking',
		},
		baseSha: {
			type: 'string',
			description: 'Base Git SHA shown in the PR comment when baseDir is not checked out',
		},
		headDir: {
			type: 'string',
			required: true,
			description: 'PR/head repository directory',
		},
		headRuntime: {
			type: 'enum',
			choices: headRuntimeChoices,
			default: 'package',
			description:
				'PR/head runtime to benchmark: package uses the published JS bin, rust uses rust/target/release/ccusage',
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
		headPackageUrl: {
			type: 'string',
			description: 'PR/head pkg.pr.new ccusage package URL used for package-runner startup timing',
		},
		packageRunnerRuns: {
			type: 'number',
			default: 3,
			description: 'Warm package-runner startup samples after the cold bunx run',
		},
		packageRunnerTimeoutMs: {
			type: 'number',
			default: 120_000,
			description: 'How long to wait for pkg.pr.new package URLs before skipping startup timing',
		},
	},
	async run(ctx) {
		assertSampleOptions({ runs: ctx.values.runs, warmup: ctx.values.warmup }, '');
		assertSampleOptions({ runs: ctx.values.largeRuns, warmup: ctx.values.largeWarmup }, 'large-');
		assertSampleOptions({ runs: ctx.values.packageRunnerRuns, warmup: 0 }, 'package-runner-');
		if (ctx.values.baseDir == null && ctx.values.basePackageUrl == null) {
			throw new Error('Either --base-dir or --base-package-url is required');
		}

		await using installFixture = await createFixture({});
		const baseDir = ctx.values.baseDir == null ? undefined : resolve(ctx.values.baseDir);
		const basePackageUrl = ctx.values.basePackageUrl;
		const headRuntime = parseHeadRuntime(ctx.values.headRuntime);
		const headPackageUrl = ctx.values.headPackageUrl;
		const basePackageInstall =
			basePackageUrl == null
				? undefined
				: await installPackageUrl({
						installDir: join(installFixture.path, 'base-package'),
						label: 'base',
						packageUrl: basePackageUrl,
						timeoutMs: ctx.values.packageRunnerTimeoutMs,
					});
		const headPackageInstall =
			headPackageUrl == null || headRuntime !== 'package'
				? undefined
				: await installPackageUrl({
						installDir: join(installFixture.path, 'head-package'),
						label: 'PR',
						packageUrl: headPackageUrl,
						timeoutMs: ctx.values.packageRunnerTimeoutMs,
					});
		const baseBinEntry =
			basePackageInstall == null ? await packageBinEntry(baseDir!) : basePackageInstall.binEntry;
		const options = {
			baseBinEntry,
			basePackageUrl,
			baseRuntimeDescription:
				basePackageUrl == null
					? undefined
					: 'Base runs the published `ccusage` package from `pkg.pr.new`, installed before measurement',
			baseSha: ctx.values.baseSha ?? (baseDir == null ? undefined : gitSha(baseDir)),
			codexFixtureDir: resolve(ctx.values.codexFixtureDir),
			fixtureDir: resolve(ctx.values.fixtureDir),
			headBinEntry: headPackageInstall?.binEntry,
			headDir: resolve(ctx.values.headDir),
			headPackageUrl,
			headRuntime,
			headRuntimeDescription:
				headPackageInstall == null
					? undefined
					: 'PR runs the published `ccusage` package from `pkg.pr.new`, installed before measurement',
			headSha: gitSha(resolve(ctx.values.headDir)),
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

		const packageRunner =
			basePackageUrl == null && options.headPackageUrl == null
				? undefined
				: {
						base:
							basePackageUrl == null
								? undefined
								: await measurePackageRunnerWithAcquisition({
										acquisition: basePackageInstall?.acquisition,
										cacheDir: join(installFixture.path, 'bunx-base-cache'),
										label: 'base',
										packageUrl: basePackageUrl,
										runs: ctx.values.packageRunnerRuns,
										timeoutMs: ctx.values.packageRunnerTimeoutMs,
									}),
						head:
							options.headPackageUrl == null
								? undefined
								: await measurePackageRunnerWithAcquisition({
										acquisition: headPackageInstall?.acquisition,
										cacheDir: join(installFixture.path, 'bunx-head-cache'),
										label: 'PR',
										packageUrl: options.headPackageUrl,
										runs: ctx.values.packageRunnerRuns,
										timeoutMs: ctx.values.packageRunnerTimeoutMs,
									}),
					};
		const sizes = {
			basePackage:
				basePackageUrl == null
					? await packedTarballSizeBytes(baseDir!)
					: await remoteTarballSizeBytes(basePackageUrl),
			baseRustBinary:
				baseDir == null ? undefined : await optionalFileSizeBytes(rustBinaryEntry(baseDir)),
			headPackage:
				options.headPackageUrl == null
					? await packedTarballSizeBytes(options.headDir)
					: await remoteTarballSizeBytes(options.headPackageUrl),
			headRustBinary: await optionalFileSizeBytes(rustBinaryEntry(options.headDir)),
		};

		const markdown = renderMarkdown(sections, sizes, { ...options, packageRunner });
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
