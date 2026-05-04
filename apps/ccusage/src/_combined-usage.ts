import type { TokenUsageSessionFile } from '../../codex/src/data-loader.ts';
import type { LoadOptions as ClaudeLoadOptions, ModelBreakdown } from './data-loader.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { uniq } from 'es-toolkit';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { loadAmpUsageEvents } from '../../amp/src/data-loader.ts';
import { logger as ampLogger } from '../../amp/src/logger.ts';
import { AmpPricingSource } from '../../amp/src/pricing.ts';
import {
	CODEX_HOME_ENV,
	DEFAULT_CODEX_DIR,
	DEFAULT_SESSION_SUBDIR,
	SESSION_GLOB,
} from '../../codex/src/_consts.ts';
import { loadTokenUsageEventsFromFiles as loadCodexTokenUsageEventsFromFiles } from '../../codex/src/data-loader.ts';
import { logger as codexLogger } from '../../codex/src/logger.ts';
import { CodexPricingSource } from '../../codex/src/pricing.ts';
import {
	calculateCostUSDForEvent as calculateCodexCostUSDForEvent,
	CODEX_COST_RULES_CACHE_KEY,
} from '../../codex/src/token-utils.ts';
import { KIMI_CONFIG_FILE_NAME, KIMI_METADATA_FILE_NAME } from '../../kimi/src/_consts.ts';
import {
	createKimiTokenUsageLoadContext,
	dedupeKimiTokenUsageEvents,
	getKimiTokenUsageFiles,
	loadTokenUsageEventsFromWireFiles,
	resolveKimiShareDir,
} from '../../kimi/src/data-loader.ts';
import { logger as kimiLogger } from '../../kimi/src/logger.ts';
import { KimiPricingSource } from '../../kimi/src/pricing.ts';
import { calculateCostUSD as calculateKimiCostUSD } from '../../kimi/src/token-utils.ts';
import { calculateCostForEntry as calculateOpenCodeCostForEntry } from '../../opencode/src/cost-utils.ts';
import {
	getOpenCodePath,
	loadOpenCodeSessions,
	openCodeMessageSchema,
} from '../../opencode/src/data-loader.ts';
import { loadPiAgentData } from '../../pi/src/data-loader.ts';
import { PricingFetcher } from './_pricing-fetcher.ts';
import { createDailyDate, createModelName } from './_types.ts';
import {
	calculateCostForEntry,
	createUniqueHash,
	extractProjectFromPath,
	getClaudePaths,
	globUsageFiles,
	processJSONLFileByLine,
	usageDataSchema,
} from './data-loader.ts';
import { logger } from './logger.ts';

export const ALL_COMBINED_ORIGINS = ['claude', 'codex', 'kimi', 'opencode', 'amp', 'pi'] as const;

export const DEFAULT_COMBINED_ORIGINS = ['claude', 'codex', 'kimi', 'opencode'] as const;

export type CombinedOrigin = (typeof ALL_COMBINED_ORIGINS)[number];

type CombinedOriginBreakdown = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
};

export type CombinedDailyUsage = {
	date: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: string[];
	modelBreakdowns: ModelBreakdown[];
	project?: string;
	originsUsed: CombinedOrigin[];
	originBreakdowns: Partial<Record<CombinedOrigin, CombinedOriginBreakdown>>;
};

export type CombinedDailyLoadOptions = Pick<
	ClaudeLoadOptions,
	'mode' | 'offline' | 'order' | 'project' | 'since' | 'timezone' | 'until'
> & {
	groupByProject?: boolean;
	origins: CombinedOrigin[];
};

type SourceDailyUsage = {
	date: string;
	origin: CombinedOrigin;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	timestamp?: string;
	uniqueHash?: string | null;
	project?: string;
	modelBreakdowns: ModelBreakdown[];
};

type CombinedSourceRowsCacheEntry = {
	version: number;
	signature: string;
	rows: SourceDailyUsage[];
};

type CombinedFileRowsCacheFileEntry<TRow = SourceDailyUsage> = {
	size: number;
	mtimeMs: number;
	rows: TRow[];
};

type CombinedFileRowsCacheEntry<TRow = SourceDailyUsage> = {
	version: number;
	files: Record<string, CombinedFileRowsCacheFileEntry<TRow>>;
};

type SourceFileReference = {
	file: string;
};

const COMBINED_SOURCE_CACHE_VERSION = 3;
const COMBINED_FILE_ROWS_CACHE_VERSION = 1;

function hashValue(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function getCombinedSourceCacheDir(): string {
	const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
	const cacheRoot =
		xdgCacheHome != null && xdgCacheHome !== '' ? xdgCacheHome : path.join(os.homedir(), '.cache');
	return path.join(cacheRoot, 'ccusage', 'combined');
}

function getCombinedSourceCachePath(
	origin: CombinedOrigin,
	options: CombinedDailyLoadOptions,
): string {
	const needsProjectGrouping = options.groupByProject === true || options.project != null;
	const key = hashValue(
		JSON.stringify({
			origin,
			mode: options.mode ?? 'auto',
			offline: options.offline ?? false,
			project: options.project ?? null,
			since: options.since ?? null,
			timezone: options.timezone ?? null,
			until: options.until ?? null,
			needsProjectGrouping,
		}),
	);
	return path.join(getCombinedSourceCacheDir(), `${origin}-${key}.json`);
}

function getCombinedFileRowsCachePath(
	origin: CombinedOrigin,
	options: CombinedDailyLoadOptions,
	cacheDiscriminator?: string,
): string {
	const needsProjectGrouping = options.groupByProject === true || options.project != null;
	const key = hashValue(
		JSON.stringify({
			origin,
			...(cacheDiscriminator != null && { cacheDiscriminator }),
			mode: options.mode ?? 'auto',
			offline: options.offline ?? false,
			project: options.project ?? null,
			since: options.since ?? null,
			timezone: options.timezone ?? null,
			until: options.until ?? null,
			needsProjectGrouping,
		}),
	);
	return path.join(getCombinedSourceCacheDir(), `${origin}-files-${key}.json`);
}

async function createFileStateSignature(paths: string[]): Promise<string> {
	const states = await Promise.all(
		uniq(paths)
			.sort((left, right) => left.localeCompare(right))
			.map(async (filePath) => {
				try {
					const fileStat = await stat(filePath);
					return `${filePath}|${fileStat.size}|${fileStat.mtimeMs}`;
				} catch {
					return `${filePath}|missing`;
				}
			}),
	);

	return hashValue(states.join('\\n'));
}

async function readCombinedSourceRowsCache(
	cachePath: string,
	signature: string,
): Promise<SourceDailyUsage[] | null> {
	try {
		const raw = await readFile(cachePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<CombinedSourceRowsCacheEntry>;
		if (
			parsed.version !== COMBINED_SOURCE_CACHE_VERSION ||
			parsed.signature !== signature ||
			!Array.isArray(parsed.rows)
		) {
			return null;
		}

		return parsed.rows;
	} catch {
		return null;
	}
}

async function writeCombinedSourceRowsCache(
	cachePath: string,
	signature: string,
	rows: SourceDailyUsage[],
): Promise<void> {
	try {
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(
			cachePath,
			JSON.stringify({
				version: COMBINED_SOURCE_CACHE_VERSION,
				signature,
				rows,
			} satisfies CombinedSourceRowsCacheEntry),
			'utf8',
		);
	} catch (error) {
		logger.debug('Failed to write combined source rows cache', error);
	}
}

async function readCombinedFileRowsCache<TRow>(
	cachePath: string,
): Promise<Record<string, CombinedFileRowsCacheFileEntry<TRow>>> {
	try {
		const raw = await readFile(cachePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<CombinedFileRowsCacheEntry<TRow>>;
		if (parsed.version !== COMBINED_FILE_ROWS_CACHE_VERSION || parsed.files == null) {
			return {};
		}

		return parsed.files;
	} catch {
		return {};
	}
}

async function writeCombinedFileRowsCache<TRow>(
	cachePath: string,
	files: Record<string, CombinedFileRowsCacheFileEntry<TRow>>,
): Promise<void> {
	try {
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(
			cachePath,
			JSON.stringify({
				version: COMBINED_FILE_ROWS_CACHE_VERSION,
				files,
			} satisfies CombinedFileRowsCacheEntry<TRow>),
			'utf8',
		);
	} catch (error) {
		logger.debug('Failed to write combined file rows cache', error);
	}
}

async function loadCombinedFileRowsWithCache<TFile extends SourceFileReference, TRow>(
	origin: CombinedOrigin,
	options: CombinedDailyLoadOptions,
	files: TFile[],
	loadRowsForFile: (file: TFile) => Promise<TRow[]>,
	cacheOptions: {
		cacheDiscriminator?: string;
		compactRows?: (rows: TRow[]) => TRow[];
	} = {},
): Promise<TRow[]> {
	const sortedFiles = [...files].sort((left, right) => left.file.localeCompare(right.file));
	const cachePath = getCombinedFileRowsCachePath(origin, options, cacheOptions.cacheDiscriminator);
	const compactRows = cacheOptions.compactRows ?? ((rows: TRow[]) => rows);

	try {
		const cachedFiles = await readCombinedFileRowsCache<TRow>(cachePath);
		const nextFiles: Record<string, CombinedFileRowsCacheFileEntry<TRow>> = {};
		const rows: TRow[] = [];
		const fileStates = await Promise.all(
			sortedFiles.map(async (sourceFile) => {
				const fileStat = await stat(sourceFile.file).catch(() => null);
				if (fileStat == null || !fileStat.isFile()) {
					return null;
				}

				return { fileStat, sourceFile };
			}),
		);
		let cacheHits = 0;
		let cacheMisses = 0;

		for (const fileState of fileStates) {
			if (fileState == null) {
				continue;
			}

			const { fileStat, sourceFile } = fileState;

			const cached = cachedFiles[sourceFile.file];
			if (
				cached != null &&
				cached.size === fileStat.size &&
				cached.mtimeMs === fileStat.mtimeMs &&
				Array.isArray(cached.rows)
			) {
				rows.push(...cached.rows);
				nextFiles[sourceFile.file] = cached;
				cacheHits++;
				continue;
			}

			const loadedRows = compactRows(await loadRowsForFile(sourceFile));
			rows.push(...loadedRows);
			nextFiles[sourceFile.file] = {
				size: fileStat.size,
				mtimeMs: fileStat.mtimeMs,
				rows: loadedRows,
			};
			cacheMisses++;
		}

		if (cacheMisses > 0 || Object.keys(cachedFiles).length !== Object.keys(nextFiles).length) {
			await writeCombinedFileRowsCache(cachePath, nextFiles);
		}

		logger.debug(
			`Combined ${origin} file rows cache: ${cacheHits} hit(s), ${cacheMisses} miss(es)`,
		);
		return compactRows(rows);
	} catch (error) {
		logger.debug(`Combined ${origin} file rows cache unavailable`, error);
		const rows: TRow[] = [];
		for (const sourceFile of sortedFiles) {
			rows.push(...(await loadRowsForFile(sourceFile)));
		}
		return compactRows(rows);
	}
}

async function loadCombinedSourceRowsWithCache(
	origin: CombinedOrigin,
	options: CombinedDailyLoadOptions,
	getSignature: () => Promise<string>,
	loadRows: () => Promise<SourceDailyUsage[]>,
): Promise<SourceDailyUsage[]> {
	try {
		const signature = await getSignature();
		const cachePath = getCombinedSourceCachePath(origin, options);
		const cachedRows = await readCombinedSourceRowsCache(cachePath, signature);
		if (cachedRows != null) {
			logger.debug(`Combined ${origin} source rows cache hit`);
			return cachedRows;
		}

		logger.debug(`Combined ${origin} source rows cache miss`);
		const rows = compactSourceRows(await loadRows());
		await writeCombinedSourceRowsCache(cachePath, signature, rows);
		return rows;
	} catch (error) {
		logger.debug(`Combined ${origin} source rows cache unavailable`, error);
		return compactSourceRows(await loadRows());
	}
}

async function getCodexSessionFiles(): Promise<TokenUsageSessionFile[]> {
	const codexHomeEnv = process.env[CODEX_HOME_ENV]?.trim();
	const codexHome =
		codexHomeEnv != null && codexHomeEnv !== '' ? path.resolve(codexHomeEnv) : DEFAULT_CODEX_DIR;
	const sessionsDir = path.join(codexHome, DEFAULT_SESSION_SUBDIR);
	const files = await glob(SESSION_GLOB, {
		cwd: sessionsDir,
		absolute: true,
	}).catch(() => []);
	return files.map((file) => ({ file, sessionDir: sessionsDir }));
}

async function getClaudeSourceSignature(): Promise<string> {
	const filesWithBase = await globUsageFiles(getClaudePaths());
	return createFileStateSignature(filesWithBase.map((entry) => entry.file));
}

async function getKimiCacheDependencySignature(shareDir: string): Promise<string> {
	return createFileStateSignature([
		path.join(shareDir, KIMI_CONFIG_FILE_NAME),
		path.join(shareDir, KIMI_METADATA_FILE_NAME),
	]);
}

async function getKimiSourceSignature(): Promise<string> {
	const shareDir = resolveKimiShareDir();
	const { context } = await createKimiTokenUsageLoadContext(shareDir);
	if (context == null) {
		return createFileStateSignature([
			path.join(shareDir, KIMI_CONFIG_FILE_NAME),
			path.join(shareDir, KIMI_METADATA_FILE_NAME),
		]);
	}

	const files = await getKimiTokenUsageFiles(context);
	return createFileStateSignature([
		path.join(shareDir, KIMI_CONFIG_FILE_NAME),
		path.join(shareDir, KIMI_METADATA_FILE_NAME),
		...files.map((entry) => entry.file),
	]);
}

type OpenCodeSourceFiles = {
	messageFiles: SourceFileReference[];
};

async function getOpenCodeSourceFiles(): Promise<OpenCodeSourceFiles | null> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}

	const messagesDir = path.join(openCodePath, 'storage', 'message');
	const messageFiles = await glob('**/*.json', {
		cwd: messagesDir,
		absolute: true,
	}).catch(() => []);

	return {
		messageFiles: messageFiles.map((file) => ({ file })),
	};
}

async function getOpenCodeSourceSignature(): Promise<string> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return createFileStateSignature([]);
	}

	const sessionsDir = path.join(openCodePath, 'storage', 'session');
	const messagesDir = path.join(openCodePath, 'storage', 'message');
	const [sessionFiles, messageFiles] = await Promise.all([
		glob('**/*.json', {
			cwd: sessionsDir,
			absolute: true,
		}).catch(() => []),
		glob('**/*.json', {
			cwd: messagesDir,
			absolute: true,
		}).catch(() => []),
	]);

	return createFileStateSignature([sessionsDir, messagesDir, ...sessionFiles, ...messageFiles]);
}

type MutableCombinedUsage = {
	date: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	project?: string;
	originsUsed: Set<CombinedOrigin>;
	originBreakdowns: Map<CombinedOrigin, CombinedOriginBreakdown>;
	modelBreakdowns: Map<string, ModelBreakdown>;
};

function prefixModel(origin: CombinedOrigin, modelName: string): string {
	return `[${origin}] ${modelName}`;
}

function createBreakdown(
	origin: CombinedOrigin,
	modelName: string,
	counts: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	},
): ModelBreakdown {
	return {
		modelName: createModelName(prefixModel(origin, modelName)),
		inputTokens: counts.inputTokens,
		outputTokens: counts.outputTokens,
		cacheCreationTokens: counts.cacheCreationTokens,
		cacheReadTokens: counts.cacheReadTokens,
		cost: counts.cost,
	};
}

function compactSourceRows(rows: SourceDailyUsage[]): SourceDailyUsage[] {
	const grouped = new Map<
		string,
		SourceDailyUsage & { modelBreakdownMap: Map<string, ModelBreakdown> }
	>();

	for (const row of rows) {
		const groupKey = `${row.date}\x00${row.origin}\x00${row.project ?? ''}`;
		const existing = grouped.get(groupKey) ?? {
			date: row.date,
			origin: row.origin,
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			...(row.project != null && { project: row.project }),
			modelBreakdowns: [],
			modelBreakdownMap: new Map<string, ModelBreakdown>(),
		};

		if (!grouped.has(groupKey)) {
			grouped.set(groupKey, existing);
		}

		existing.inputTokens += row.inputTokens;
		existing.outputTokens += row.outputTokens;
		existing.cacheCreationTokens += row.cacheCreationTokens;
		existing.cacheReadTokens += row.cacheReadTokens;
		existing.totalCost += row.totalCost;

		for (const breakdown of row.modelBreakdowns) {
			const current = existing.modelBreakdownMap.get(breakdown.modelName) ?? {
				...breakdown,
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0,
			};

			current.inputTokens += breakdown.inputTokens;
			current.outputTokens += breakdown.outputTokens;
			current.cacheCreationTokens += breakdown.cacheCreationTokens;
			current.cacheReadTokens += breakdown.cacheReadTokens;
			current.cost += breakdown.cost;

			existing.modelBreakdownMap.set(breakdown.modelName, current);
		}
	}

	return Array.from(grouped.values())
		.map(({ modelBreakdownMap, ...row }) => ({
			...row,
			modelBreakdowns: Array.from(modelBreakdownMap.values()).sort((a, b) =>
				a.modelName.localeCompare(b.modelName),
			),
		}))
		.sort((a, b) => {
			const dateComparison = a.date.localeCompare(b.date);
			if (dateComparison !== 0) {
				return dateComparison;
			}

			const projectComparison = (a.project ?? '').localeCompare(b.project ?? '');
			if (projectComparison !== 0) {
				return projectComparison;
			}

			return a.origin.localeCompare(b.origin);
		});
}

function normalizeProject(project: string | undefined): string | undefined {
	if (project == null) {
		return undefined;
	}

	const trimmed = project.trim();
	return trimmed === '' ? undefined : trimmed;
}

function formatDateKey(value: Date | string, timezone?: string): string {
	const date = typeof value === 'string' ? new Date(value) : value;
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
	const parts = formatter.formatToParts(date);
	const year = parts.find((part) => part.type === 'year')?.value ?? '';
	const month = parts.find((part) => part.type === 'month')?.value ?? '';
	const day = parts.find((part) => part.type === 'day')?.value ?? '';
	return `${year}-${month}-${day}`;
}

function isWithinDateRange(dateKey: string, since?: string, until?: string): boolean {
	const normalized = dateKey.replaceAll('-', '');

	if (since != null && normalized < since) {
		return false;
	}

	if (until != null && normalized > until) {
		return false;
	}

	return true;
}

function extractSessionDirectory(sessionId: string): string | undefined {
	const separatorIndex = sessionId.lastIndexOf('/');
	if (separatorIndex <= 0) {
		return undefined;
	}

	return normalizeProject(sessionId.slice(0, separatorIndex));
}

function selectProject(
	project: string | undefined,
	projectFilter: string | undefined,
	needsProjectGrouping: boolean,
): string | undefined | null {
	const normalized = normalizeProject(project);
	const groupedProject = needsProjectGrouping ? (normalized ?? 'unknown') : undefined;

	if (projectFilter == null) {
		return groupedProject;
	}

	return (normalized ?? 'unknown') === projectFilter ? groupedProject : null;
}

function compareTimestamps(left: string, right: string): number {
	const leftMs = Date.parse(left);
	const rightMs = Date.parse(right);

	if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
		return left.localeCompare(right);
	}

	return leftMs - rightMs;
}

function dedupeSourceRowsByEarliestTimestamp(rows: SourceDailyUsage[]): SourceDailyUsage[] {
	const earliestByHash = new Map<string, SourceDailyUsage>();

	for (const row of rows) {
		const uniqueHash = row.uniqueHash;
		const timestamp = row.timestamp;
		if (uniqueHash == null || timestamp == null) {
			continue;
		}

		const existing = earliestByHash.get(uniqueHash);
		if (
			existing == null ||
			existing.timestamp == null ||
			compareTimestamps(timestamp, existing.timestamp) < 0
		) {
			earliestByHash.set(uniqueHash, row);
		}
	}

	return rows.filter((row) => {
		const uniqueHash = row.uniqueHash;
		return uniqueHash == null || earliestByHash.get(uniqueHash) === row;
	});
}

function getClaudeDisplayModelName(
	data: v.InferOutput<typeof usageDataSchema>,
): string | undefined {
	const model = data.message.model;
	if (model == null) {
		return undefined;
	}

	return data.message.usage.speed === 'fast' ? `${model}-fast` : model;
}

export function setCombinedOriginLoggerLevel(level: number): void {
	codexLogger.level = level;
	kimiLogger.level = level;
	ampLogger.level = level;
}

async function getCachedValue<T>(
	cache: Map<string, Promise<T>>,
	key: string,
	loadValue: () => Promise<T>,
): Promise<T> {
	const existing = cache.get(key);
	if (existing != null) {
		return existing;
	}

	const created = loadValue();
	cache.set(key, created);
	return created;
}

function aggregateCombinedUsage(
	sourceRows: SourceDailyUsage[],
	options: CombinedDailyLoadOptions,
): CombinedDailyUsage[] {
	const needsProjectGrouping = options.groupByProject === true || options.project != null;
	const grouped = new Map<string, MutableCombinedUsage>();

	for (const sourceRow of sourceRows) {
		const project = needsProjectGrouping ? (sourceRow.project ?? 'unknown') : undefined;
		const groupKey = project != null ? `${sourceRow.date}\x00${project}` : sourceRow.date;

		const existing = grouped.get(groupKey) ?? {
			date: sourceRow.date,
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			project,
			originsUsed: new Set<CombinedOrigin>(),
			originBreakdowns: new Map<CombinedOrigin, CombinedOriginBreakdown>(),
			modelBreakdowns: new Map<string, ModelBreakdown>(),
		};

		if (!grouped.has(groupKey)) {
			grouped.set(groupKey, existing);
		}

		existing.inputTokens += sourceRow.inputTokens;
		existing.outputTokens += sourceRow.outputTokens;
		existing.cacheCreationTokens += sourceRow.cacheCreationTokens;
		existing.cacheReadTokens += sourceRow.cacheReadTokens;
		existing.totalCost += sourceRow.totalCost;
		existing.originsUsed.add(sourceRow.origin);

		const originBreakdown = existing.originBreakdowns.get(sourceRow.origin) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
			totalCost: 0,
		};
		originBreakdown.inputTokens += sourceRow.inputTokens;
		originBreakdown.outputTokens += sourceRow.outputTokens;
		originBreakdown.cacheCreationTokens += sourceRow.cacheCreationTokens;
		originBreakdown.cacheReadTokens += sourceRow.cacheReadTokens;
		originBreakdown.totalTokens +=
			sourceRow.inputTokens +
			sourceRow.outputTokens +
			sourceRow.cacheCreationTokens +
			sourceRow.cacheReadTokens;
		originBreakdown.totalCost += sourceRow.totalCost;
		existing.originBreakdowns.set(sourceRow.origin, originBreakdown);

		for (const modelBreakdown of sourceRow.modelBreakdowns) {
			const current = existing.modelBreakdowns.get(modelBreakdown.modelName) ?? {
				...modelBreakdown,
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0,
			};

			current.inputTokens += modelBreakdown.inputTokens;
			current.outputTokens += modelBreakdown.outputTokens;
			current.cacheCreationTokens += modelBreakdown.cacheCreationTokens;
			current.cacheReadTokens += modelBreakdown.cacheReadTokens;
			current.cost += modelBreakdown.cost;

			existing.modelBreakdowns.set(modelBreakdown.modelName, current);
		}
	}

	const rows = Array.from(grouped.values()).map<CombinedDailyUsage>((entry) => ({
		date: createDailyDate(entry.date),
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: entry.cacheCreationTokens,
		cacheReadTokens: entry.cacheReadTokens,
		totalCost: entry.totalCost,
		modelsUsed: uniq(Array.from(entry.modelBreakdowns.keys())),
		modelBreakdowns: Array.from(entry.modelBreakdowns.values()).sort((a, b) =>
			a.modelName.localeCompare(b.modelName),
		),
		...(entry.project != null && { project: entry.project }),
		originsUsed: Array.from(entry.originsUsed).sort(),
		originBreakdowns: Object.fromEntries(
			Array.from(entry.originBreakdowns.entries()).sort(([originA], [originB]) =>
				originA.localeCompare(originB),
			),
		) as Partial<Record<CombinedOrigin, CombinedOriginBreakdown>>,
	}));

	const compare = options.order === 'desc' ? -1 : 1;
	rows.sort((a, b) => {
		const dateComparison = a.date.localeCompare(b.date) * compare;
		if (dateComparison !== 0) {
			return dateComparison;
		}

		return (a.project ?? '').localeCompare(b.project ?? '');
	});

	return rows;
}

async function loadClaudeSourceRows(
	options: CombinedDailyLoadOptions,
): Promise<SourceDailyUsage[]> {
	return loadCombinedSourceRowsWithCache('claude', options, getClaudeSourceSignature, async () => {
		const filesWithBase = await globUsageFiles(getClaudePaths());
		if (filesWithBase.length === 0) {
			return [];
		}

		const needsProjectGrouping = options.groupByProject === true || options.project != null;
		const mode = options.mode ?? 'auto';
		using fetcher = mode === 'display' ? null : new PricingFetcher(options.offline);

		const rows = await loadCombinedFileRowsWithCache(
			'claude',
			options,
			filesWithBase,
			async ({ file }) => {
				const project = selectProject(
					extractProjectFromPath(file),
					options.project,
					needsProjectGrouping,
				);
				if (project === null) {
					return [];
				}

				const sourceRows: SourceDailyUsage[] = [];
				await processJSONLFileByLine(file, async (line) => {
					try {
						const parsed = JSON.parse(line) as unknown;
						const result = v.safeParse(usageDataSchema, parsed);
						if (!result.success) {
							return;
						}

						const data = result.output;
						const date = formatDateKey(data.timestamp, options.timezone);
						if (!isWithinDateRange(date, options.since, options.until)) {
							return;
						}

						const cost =
							fetcher != null
								? await calculateCostForEntry(data, mode, fetcher)
								: (data.costUSD ?? 0);
						const usage = data.message.usage;
						const model = getClaudeDisplayModelName(data) ?? 'unknown';
						const modelBreakdowns =
							model === '<synthetic>'
								? []
								: [
										createBreakdown('claude', model, {
											inputTokens: usage.input_tokens,
											outputTokens: usage.output_tokens,
											cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
											cacheReadTokens: usage.cache_read_input_tokens ?? 0,
											cost,
										}),
									];

						sourceRows.push({
							date,
							origin: 'claude',
							inputTokens: usage.input_tokens,
							outputTokens: usage.output_tokens,
							cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
							cacheReadTokens: usage.cache_read_input_tokens ?? 0,
							totalCost: cost,
							timestamp: data.timestamp,
							uniqueHash: createUniqueHash(data),
							...(project != null && { project }),
							modelBreakdowns,
						});
					} catch {
						// Skip invalid JSON lines, matching the Claude data loader behavior.
					}
				});

				return sourceRows;
			},
		);

		return compactSourceRows(dedupeSourceRowsByEarliestTimestamp(rows));
	});
}

async function loadCodexSourceRows(options: CombinedDailyLoadOptions): Promise<SourceDailyUsage[]> {
	const needsProjectGrouping = options.groupByProject === true || options.project != null;
	const sessionFiles = await getCodexSessionFiles();
	if (sessionFiles.length === 0) {
		return [];
	}

	using pricingSource = new CodexPricingSource({
		offline: options.offline,
	});
	const pricingCache = new Map<
		string,
		Promise<Awaited<ReturnType<CodexPricingSource['getPricing']>>>
	>();

	return await loadCombinedFileRowsWithCache(
		'codex',
		options,
		sessionFiles,
		async (sessionFile) => {
			const events = await loadCodexTokenUsageEventsFromFiles([sessionFile]);
			const rows: SourceDailyUsage[] = [];

			for (const event of events) {
				const model = event.model?.trim();
				if (model == null || model === '') {
					continue;
				}

				const date = formatDateKey(event.timestamp, options.timezone);
				if (!isWithinDateRange(date, options.since, options.until)) {
					continue;
				}

				const project = selectProject(
					event.projectPath ?? extractSessionDirectory(event.sessionId),
					options.project,
					needsProjectGrouping,
				);
				if (project === null) {
					continue;
				}

				const cacheReadTokens = Math.min(event.cachedInputTokens, event.inputTokens);
				const inputTokens = Math.max(event.inputTokens - cacheReadTokens, 0);
				const pricing = await getCachedValue(pricingCache, model, async () =>
					pricingSource.getPricing(model),
				);
				const totalCost = calculateCodexCostUSDForEvent(event, pricing);

				rows.push({
					date,
					origin: 'codex',
					inputTokens,
					outputTokens: event.outputTokens,
					cacheCreationTokens: 0,
					cacheReadTokens,
					totalCost,
					...(project != null && { project }),
					modelBreakdowns: [
						createBreakdown('codex', model, {
							inputTokens,
							outputTokens: event.outputTokens,
							cacheCreationTokens: 0,
							cacheReadTokens,
							cost: totalCost,
						}),
					],
				});
			}

			return rows;
		},
		{
			cacheDiscriminator: CODEX_COST_RULES_CACHE_KEY,
			compactRows: compactSourceRows,
		},
	);
}

async function loadKimiSourceRows(options: CombinedDailyLoadOptions): Promise<SourceDailyUsage[]> {
	return loadCombinedSourceRowsWithCache('kimi', options, getKimiSourceSignature, async () => {
		const needsProjectGrouping = options.groupByProject === true || options.project != null;
		const shareDir = resolveKimiShareDir();
		const { context } = await createKimiTokenUsageLoadContext(shareDir);
		if (context == null) {
			return [];
		}

		const files = await getKimiTokenUsageFiles(context);
		if (files.length === 0) {
			return [];
		}

		const cacheDiscriminator = await getKimiCacheDependencySignature(shareDir);
		const cachedEvents = await loadCombinedFileRowsWithCache(
			'kimi',
			options,
			files,
			async (file) => loadTokenUsageEventsFromWireFiles([file], context),
			{ cacheDiscriminator },
		);
		const events = dedupeKimiTokenUsageEvents(cachedEvents);

		const pricingSource = new KimiPricingSource();
		const pricingCache = new Map<
			string,
			Promise<Awaited<ReturnType<KimiPricingSource['getPricing']>>>
		>();
		const rows: SourceDailyUsage[] = [];

		for (const event of events) {
			const model = event.model?.trim();
			if (model == null || model === '') {
				continue;
			}

			const date = formatDateKey(event.timestamp, options.timezone);
			if (!isWithinDateRange(date, options.since, options.until)) {
				continue;
			}

			const project = selectProject(
				extractSessionDirectory(event.sessionId),
				options.project,
				needsProjectGrouping,
			);
			if (project === null) {
				continue;
			}

			const cacheReadTokens = Math.min(event.cachedInputTokens, event.inputTokens);
			const inputTokens = Math.max(event.inputTokens - cacheReadTokens, 0);
			const pricing = await getCachedValue(pricingCache, model, async () =>
				pricingSource.getPricing(model),
			);
			const totalCost = calculateKimiCostUSD(event, pricing);

			rows.push({
				date,
				origin: 'kimi',
				inputTokens,
				outputTokens: event.outputTokens,
				cacheCreationTokens: 0,
				cacheReadTokens,
				totalCost,
				timestamp: event.timestamp,
				uniqueHash: event.dedupeKey ?? null,
				...(project != null && { project }),
				modelBreakdowns: [
					createBreakdown('kimi', model, {
						inputTokens,
						outputTokens: event.outputTokens,
						cacheCreationTokens: 0,
						cacheReadTokens,
						cost: totalCost,
					}),
				],
			});
		}

		return compactSourceRows(dedupeSourceRowsByEarliestTimestamp(rows));
	});
}

async function loadOpenCodeSourceRows(
	options: CombinedDailyLoadOptions,
): Promise<SourceDailyUsage[]> {
	return loadCombinedSourceRowsWithCache(
		'opencode',
		options,
		getOpenCodeSourceSignature,
		async () => {
			type OpenCodeCachedUsage = {
				date: string;
				timestamp: string;
				sessionID: string;
				model: string;
				inputTokens: number;
				outputTokens: number;
				cacheCreationTokens: number;
				cacheReadTokens: number;
				totalCost: number;
				uniqueHash: string | null;
			};

			const sourceFiles = await getOpenCodeSourceFiles();
			if (sourceFiles == null || sourceFiles.messageFiles.length === 0) {
				return [];
			}

			using fetcher = new LiteLLMPricingFetcher({
				offline: options.offline ?? false,
				logger,
			});

			const cachedEntries = await loadCombinedFileRowsWithCache<
				SourceFileReference,
				OpenCodeCachedUsage
			>('opencode', options, sourceFiles.messageFiles, async ({ file }) => {
				const content = await readFile(file, 'utf-8').catch(() => null);
				if (content == null) {
					return [];
				}

				const parsed = Result.try({
					try: () => JSON.parse(content) as unknown,
					catch: (error) => error,
				})();
				if (Result.isFailure(parsed)) {
					return [];
				}

				const message = v.safeParse(openCodeMessageSchema, parsed.value);
				if (!message.success) {
					return [];
				}

				if (
					message.output.tokens == null ||
					(message.output.tokens.input === 0 && message.output.tokens.output === 0)
				) {
					return [];
				}

				if (message.output.providerID == null || message.output.modelID == null) {
					return [];
				}

				const timestamp = new Date(message.output.time.created ?? Date.now());
				const date = formatDateKey(timestamp, options.timezone);
				if (!isWithinDateRange(date, options.since, options.until)) {
					return [];
				}

				const entry = {
					timestamp,
					sessionID: message.output.sessionID ?? 'unknown',
					usage: {
						inputTokens: message.output.tokens.input ?? 0,
						outputTokens: message.output.tokens.output ?? 0,
						cacheCreationInputTokens: message.output.tokens.cache?.write ?? 0,
						cacheReadInputTokens: message.output.tokens.cache?.read ?? 0,
					},
					model: message.output.modelID,
					costUSD: message.output.cost ?? null,
				};
				const totalCost = await calculateOpenCodeCostForEntry(entry, fetcher);

				return [
					{
						date,
						timestamp: timestamp.toISOString(),
						sessionID: entry.sessionID,
						model: entry.model,
						inputTokens: entry.usage.inputTokens,
						outputTokens: entry.usage.outputTokens,
						cacheCreationTokens: entry.usage.cacheCreationInputTokens,
						cacheReadTokens: entry.usage.cacheReadInputTokens,
						totalCost,
						uniqueHash: message.output.id,
					},
				];
			});

			const needsProjectGrouping = options.groupByProject === true || options.project != null;
			const sessions = await loadOpenCodeSessions();
			const rows: SourceDailyUsage[] = [];

			for (const entry of cachedEntries) {
				const metadata = sessions.get(entry.sessionID);
				const rawProject = normalizeProject(metadata?.directory ?? metadata?.projectID);
				const project = selectProject(rawProject, options.project, needsProjectGrouping);
				if (project === null) {
					continue;
				}

				rows.push({
					date: entry.date,
					origin: 'opencode',
					inputTokens: entry.inputTokens,
					outputTokens: entry.outputTokens,
					cacheCreationTokens: entry.cacheCreationTokens,
					cacheReadTokens: entry.cacheReadTokens,
					totalCost: entry.totalCost,
					timestamp: entry.timestamp,
					uniqueHash: entry.uniqueHash,
					...(project != null && { project }),
					modelBreakdowns: [
						createBreakdown('opencode', entry.model, {
							inputTokens: entry.inputTokens,
							outputTokens: entry.outputTokens,
							cacheCreationTokens: entry.cacheCreationTokens,
							cacheReadTokens: entry.cacheReadTokens,
							cost: entry.totalCost,
						}),
					],
				});
			}

			return compactSourceRows(dedupeSourceRowsByEarliestTimestamp(rows));
		},
	);
}

async function loadPiSourceRows(options: CombinedDailyLoadOptions): Promise<SourceDailyUsage[]> {
	const needsProjectGrouping = options.groupByProject === true || options.project != null;
	const entries = await loadPiAgentData({
		since: options.since,
		timezone: options.timezone,
		until: options.until,
	});
	if (entries.length === 0) {
		return [];
	}

	const rows: SourceDailyUsage[] = [];

	for (const entry of entries) {
		const date = formatDateKey(entry.timestamp, options.timezone);
		if (!isWithinDateRange(date, options.since, options.until)) {
			continue;
		}

		const project = selectProject(entry.project, options.project, needsProjectGrouping);
		if (project === null) {
			continue;
		}

		const model = entry.model ?? 'unknown';
		rows.push({
			date,
			origin: 'pi',
			inputTokens: entry.inputTokens,
			outputTokens: entry.outputTokens,
			cacheCreationTokens: entry.cacheCreationTokens,
			cacheReadTokens: entry.cacheReadTokens,
			totalCost: entry.cost,
			...(project != null && { project }),
			modelBreakdowns: [
				createBreakdown('pi', model, {
					inputTokens: entry.inputTokens,
					outputTokens: entry.outputTokens,
					cacheCreationTokens: entry.cacheCreationTokens,
					cacheReadTokens: entry.cacheReadTokens,
					cost: entry.cost,
				}),
			],
		});
	}

	return rows;
}

async function loadAmpSourceRows(options: CombinedDailyLoadOptions): Promise<SourceDailyUsage[]> {
	const needsProjectGrouping = options.groupByProject === true || options.project != null;
	const { events } = await loadAmpUsageEvents();
	if (events.length === 0) {
		return [];
	}

	using pricingSource = new AmpPricingSource({
		offline: options.offline,
	});
	const rows: SourceDailyUsage[] = [];

	for (const event of events) {
		const date = formatDateKey(event.timestamp, options.timezone);
		if (!isWithinDateRange(date, options.since, options.until)) {
			continue;
		}

		const project = selectProject(undefined, options.project, needsProjectGrouping);
		if (project === null) {
			continue;
		}

		const totalCost = await pricingSource.calculateCost(event.model, {
			inputTokens: event.inputTokens,
			outputTokens: event.outputTokens,
			cacheCreationInputTokens: event.cacheCreationInputTokens,
			cacheReadInputTokens: event.cacheReadInputTokens,
		});

		rows.push({
			date,
			origin: 'amp',
			inputTokens: event.inputTokens,
			outputTokens: event.outputTokens,
			cacheCreationTokens: event.cacheCreationInputTokens,
			cacheReadTokens: event.cacheReadInputTokens,
			totalCost,
			...(project != null && { project }),
			modelBreakdowns: [
				createBreakdown('amp', event.model, {
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					cacheCreationTokens: event.cacheCreationInputTokens,
					cacheReadTokens: event.cacheReadInputTokens,
					cost: totalCost,
				}),
			],
		});
	}

	return rows;
}

export function parseCombinedOriginsArg(value: string | undefined): CombinedOrigin[] {
	if (value == null || value.trim() === '') {
		return Array.from(DEFAULT_COMBINED_ORIGINS);
	}

	const requested = value
		.split(',')
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part !== '');

	if (requested.length === 0) {
		return Array.from(DEFAULT_COMBINED_ORIGINS);
	}

	if (requested.includes('all')) {
		return Array.from(ALL_COMBINED_ORIGINS);
	}

	const invalid = requested.filter(
		(origin): origin is string => !ALL_COMBINED_ORIGINS.includes(origin as CombinedOrigin),
	);
	if (invalid.length > 0) {
		throw new Error(
			`Unknown origins: ${invalid.join(', ')}. Valid values: ${ALL_COMBINED_ORIGINS.join(', ')}, all`,
		);
	}

	return uniq(requested) as CombinedOrigin[];
}

export async function loadCombinedDailyUsage(
	options: CombinedDailyLoadOptions,
): Promise<CombinedDailyUsage[]> {
	const loaders: Partial<Record<CombinedOrigin, () => Promise<SourceDailyUsage[]>>> = {
		claude: async () => loadClaudeSourceRows(options),
		codex: async () => loadCodexSourceRows(options),
		kimi: async () => loadKimiSourceRows(options),
		opencode: async () => loadOpenCodeSourceRows(options),
		amp: async () => loadAmpSourceRows(options),
		pi: async () => loadPiSourceRows(options),
	};

	const sourceRows = (
		await Promise.all(
			options.origins.map(async (origin) => {
				const loadRows = loaders[origin];
				return loadRows == null ? [] : loadRows();
			}),
		)
	).flat();

	return aggregateCombinedUsage(sourceRows, options);
}

if (import.meta.vitest != null) {
	describe('parseCombinedOriginsArg', () => {
		it('defaults to the core origins', () => {
			expect(parseCombinedOriginsArg(undefined)).toEqual(DEFAULT_COMBINED_ORIGINS);
		});

		it('supports the all shortcut', () => {
			expect(parseCombinedOriginsArg('all')).toEqual(ALL_COMBINED_ORIGINS);
		});

		it('rejects unknown origins', () => {
			expect(() => parseCombinedOriginsArg('claude,unknown')).toThrow('Unknown origins');
		});
	});

	describe('loadCombinedDailyUsage helpers', () => {
		it('aggregates rows from multiple origins by day and project', async () => {
			const rows = aggregateCombinedUsage(
				[
					{
						date: '2026-04-15',
						origin: 'claude',
						inputTokens: 10,
						outputTokens: 5,
						cacheCreationTokens: 0,
						cacheReadTokens: 2,
						totalCost: 0.1,
						project: '/tmp/project-a',
						modelBreakdowns: [
							createBreakdown('claude', 'claude-sonnet-4-20250514', {
								inputTokens: 10,
								outputTokens: 5,
								cacheCreationTokens: 0,
								cacheReadTokens: 2,
								cost: 0.1,
							}),
						],
					},
					{
						date: '2026-04-15',
						origin: 'codex',
						inputTokens: 3,
						outputTokens: 7,
						cacheCreationTokens: 0,
						cacheReadTokens: 1,
						totalCost: 0.2,
						project: '/tmp/project-a',
						modelBreakdowns: [
							createBreakdown('codex', 'gpt-5-codex', {
								inputTokens: 3,
								outputTokens: 7,
								cacheCreationTokens: 0,
								cacheReadTokens: 1,
								cost: 0.2,
							}),
						],
					},
					{
						date: '2026-04-15',
						origin: 'kimi',
						inputTokens: 8,
						outputTokens: 1,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0.05,
						project: '/tmp/project-b',
						modelBreakdowns: [
							createBreakdown('kimi', 'kimi-for-coding', {
								inputTokens: 8,
								outputTokens: 1,
								cacheCreationTokens: 0,
								cacheReadTokens: 0,
								cost: 0.05,
							}),
						],
					},
				],
				{
					groupByProject: true,
					origins: ['claude', 'codex', 'kimi', 'opencode'],
				},
			);

			expect(rows).toHaveLength(2);
			expect(rows[0]?.project).toBe('/tmp/project-a');
			expect(rows[0]?.originsUsed).toEqual(['claude', 'codex']);
			expect(rows[0]?.inputTokens).toBe(13);
			expect(rows[0]?.outputTokens).toBe(12);
			expect(rows[0]?.cacheReadTokens).toBe(3);
			expect(rows[0]?.totalCost).toBeCloseTo(0.3);
			expect(rows[1]?.project).toBe('/tmp/project-b');
			expect(rows[1]?.originsUsed).toEqual(['kimi']);
		});
	});
}
