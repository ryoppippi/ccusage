import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { Result } from '@praha/byethrow';
import { isDirectorySync } from 'path-type';
import * as v from 'valibot';
import { logger } from '../../logger.ts';
import { createEmptyRow, formatDateKey, isWithinRange, normalizeDateFilter } from '../shared.ts';

const DEFAULT_OPENCODE_PATH = path.join(homedir(), '.local/share/opencode');
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';
const OPENCODE_DB_FILE_NAME = 'opencode.db';
const OPENCODE_STORAGE_DIR_NAME = 'storage';
const OPENCODE_MESSAGES_DIR_NAME = 'message';
const OPENCODE_CHANNEL_DB_PATTERN = /^opencode-[\w-]+\.db$/u;

const modelNameSchema = v.pipe(v.string(), v.minLength(1), v.brand('ModelName'));
const sessionIdSchema = v.pipe(v.string(), v.minLength(1), v.brand('SessionId'));

const openCodeTokensSchema = v.object({
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	reasoning: v.optional(v.number()),
	cache: v.optional(
		v.object({
			read: v.optional(v.number()),
			write: v.optional(v.number()),
		}),
	),
});

const openCodeMessageSchema = v.object({
	id: v.string(),
	sessionID: v.optional(sessionIdSchema),
	providerID: v.optional(v.string()),
	modelID: v.optional(modelNameSchema),
	time: v.object({
		created: v.optional(v.number()),
		completed: v.optional(v.number()),
	}),
	tokens: v.optional(openCodeTokensSchema),
	cost: v.optional(v.number()),
});

const openCodeDbMessageRowSchema = v.object({
	id: v.string(),
	session_id: v.string(),
	data: v.string(),
});

type LoadedUsageEntry = {
	timestamp: Date;
	sessionID: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	model: string;
	providerID: string;
	costUSD: number | null;
};

function getOpenCodePath(): string | null {
	const envPath = process.env[OPENCODE_CONFIG_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			return normalizedPath;
		}
	}

	return isDirectorySync(DEFAULT_OPENCODE_PATH) ? DEFAULT_OPENCODE_PATH : null;
}

function hasOpenCodeDatabase(openCodePath: string): boolean {
	if (existsSync(path.join(openCodePath, OPENCODE_DB_FILE_NAME))) {
		return true;
	}
	try {
		return readdirSync(openCodePath).some((entry) => OPENCODE_CHANNEL_DB_PATTERN.test(entry));
	} catch {
		return false;
	}
}

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return (await collectFilesRecursive(root, { extension })).length > 0;
}

export async function detectOpenCode(): Promise<boolean> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return false;
	}
	return (
		hasOpenCodeDatabase(openCodePath) ||
		(await hasFiles(
			path.join(openCodePath, OPENCODE_STORAGE_DIR_NAME, OPENCODE_MESSAGES_DIR_NAME),
			'.json',
		))
	);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	const result = Result.try({
		try: () => JSON.parse(value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		return null;
	}
	if (typeof result.value !== 'object' || result.value == null || Array.isArray(result.value)) {
		return null;
	}
	return result.value as Record<string, unknown>;
}

function hasBillableTokenUsage(tokens: v.InferOutput<typeof openCodeTokensSchema>): boolean {
	return (
		(tokens.input ?? 0) > 0 ||
		(tokens.output ?? 0) > 0 ||
		(tokens.reasoning ?? 0) > 0 ||
		(tokens.cache?.read ?? 0) > 0 ||
		(tokens.cache?.write ?? 0) > 0
	);
}

function shouldLoadOpenCodeMessage(message: v.InferOutput<typeof openCodeMessageSchema>): boolean {
	return (
		message.tokens?.input != null &&
		message.tokens.output != null &&
		message.tokens.cache?.read != null &&
		message.tokens.cache.write != null &&
		hasBillableTokenUsage(message.tokens) &&
		message.providerID != null &&
		message.modelID != null
	);
}

function convertOpenCodeMessageToUsageEntry(
	message: v.InferOutput<typeof openCodeMessageSchema>,
): LoadedUsageEntry {
	return {
		timestamp: new Date(message.time.created ?? Date.now()),
		sessionID: message.sessionID ?? 'unknown',
		usage: {
			inputTokens: message.tokens?.input ?? 0,
			outputTokens: message.tokens?.output ?? 0,
			cacheCreationInputTokens: message.tokens?.cache?.write ?? 0,
			cacheReadInputTokens: message.tokens?.cache?.read ?? 0,
		},
		model: message.modelID ?? 'unknown',
		providerID: message.providerID ?? 'unknown',
		costUSD: message.cost ?? null,
	};
}

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
	const relativePath = path.relative(directoryPath, targetPath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveOpenCodeDbCandidate(dbPath: string, resolvedOpenCodePath: string): string | null {
	const result = Result.try({
		try: () => realpathSync(dbPath),
		catch: (error) => error,
	})();
	if (Result.isFailure(result) || !isPathInsideDirectory(result.value, resolvedOpenCodePath)) {
		return null;
	}
	return result.value;
}

function getOpenCodeDbPath(openCodePath: string): string | null {
	const resolvedPath = Result.try({
		try: () => realpathSync(openCodePath),
		catch: (error) => error,
	})();
	if (Result.isFailure(resolvedPath)) {
		logger.warn('Failed to resolve OpenCode data directory:', resolvedPath.error);
		return null;
	}

	const defaultDbPath = path.join(openCodePath, OPENCODE_DB_FILE_NAME);
	if (existsSync(defaultDbPath)) {
		const resolvedDefaultDbPath = resolveOpenCodeDbCandidate(defaultDbPath, resolvedPath.value);
		if (resolvedDefaultDbPath != null) {
			return resolvedDefaultDbPath;
		}
	}

	const entries = Result.try({
		try: () => readdirSync(openCodePath),
		catch: (error) => error,
	})();
	if (Result.isFailure(entries)) {
		logger.warn('Failed to read OpenCode data directory:', entries.error);
		return null;
	}

	for (const entry of entries.value
		.filter((name) => OPENCODE_CHANNEL_DB_PATTERN.test(name))
		.sort()) {
		const resolvedDbPath = resolveOpenCodeDbCandidate(
			path.join(openCodePath, entry),
			resolvedPath.value,
		);
		if (resolvedDbPath != null) {
			return resolvedDbPath;
		}
	}

	return null;
}

function loadOpenCodeMessagesFromDb(openCodePath: string): {
	entries: LoadedUsageEntry[];
	seenIds: Set<string>;
} {
	const dbPath = getOpenCodeDbPath(openCodePath);
	if (dbPath == null || getSqliteDatabaseFactory() == null) {
		return { entries: [], seenIds: new Set() };
	}

	const result = Result.try({
		try: () =>
			withSqliteDatabase(
				dbPath,
				{ readOnly: true },
				(db) => {
					const rows = db.prepare('SELECT id, session_id, data FROM message').all();
					const entries: LoadedUsageEntry[] = [];
					const seenIds = new Set<string>();
					for (const rawRow of rows) {
						const rowResult = v.safeParse(openCodeDbMessageRowSchema, rawRow);
						if (!rowResult.success) {
							continue;
						}

						const data = parseJsonObject(rowResult.output.data);
						if (data == null) {
							continue;
						}

						const message = {
							...data,
							id: rowResult.output.id,
							sessionID: rowResult.output.session_id,
						};
						const parsed = v.safeParse(openCodeMessageSchema, message);
						if (!parsed.success || !shouldLoadOpenCodeMessage(parsed.output)) {
							continue;
						}

						seenIds.add(parsed.output.id);
						entries.push(convertOpenCodeMessageToUsageEntry(parsed.output));
					}
					return { entries, seenIds };
				},
				logger.warn,
			),
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		logger.warn('Failed to load OpenCode messages from DB:', result.error);
		return { entries: [], seenIds: new Set() };
	}
	return result.value ?? { entries: [], seenIds: new Set() };
}

async function loadOpenCodeMessageFile(filePath: string): Promise<{
	id: string;
	entry: LoadedUsageEntry;
} | null> {
	const content = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => error,
	});
	if (Result.isFailure(content)) {
		return null;
	}

	const data = parseJsonObject(content.value);
	if (data == null) {
		return null;
	}

	const parsed = v.safeParse(openCodeMessageSchema, data);
	if (!parsed.success || !shouldLoadOpenCodeMessage(parsed.output)) {
		return null;
	}

	return {
		id: parsed.output.id,
		entry: convertOpenCodeMessageToUsageEntry(parsed.output),
	};
}

async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const { entries, seenIds } = loadOpenCodeMessagesFromDb(openCodePath);
	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);
	if (!isDirectorySync(messagesDir)) {
		return entries;
	}

	const messageFiles = await collectFilesRecursive(messagesDir, { extension: '.json' });
	const messageResults = await Promise.all(messageFiles.map(loadOpenCodeMessageFile));
	for (const result of messageResults) {
		if (result == null || seenIds.has(result.id)) {
			continue;
		}
		seenIds.add(result.id);
		entries.push(result.entry);
	}

	return entries;
}

const MODEL_ALIASES: Record<string, string> = {
	'gemini-3-pro-high': 'gemini-3-pro-preview',
};

function resolveModelName(modelName: string): string {
	return MODEL_ALIASES[modelName] ?? modelName;
}

function normalizeOpenCodeProviderID(providerID: string): string {
	return providerID.replaceAll('-', '_');
}

function normalizeOpenCodeModelName(modelName: string): string {
	const resolved = resolveModelName(modelName);
	return resolved
		.replace(/^(claude-(?:haiku|opus|sonnet)-\d+)\.(\d+)(-.*)?$/u, '$1-$2$3')
		.replace(/^(claude-(?:haiku|opus|sonnet)-\d)(\d)(-.*)?$/u, '$1-$2$3');
}

function createModelCandidates(entry: LoadedUsageEntry): string[] {
	const resolved = resolveModelName(entry.model);
	const normalized = normalizeOpenCodeModelName(resolved);
	const baseCandidates = normalized === resolved ? [resolved] : [normalized];
	const candidates = [...baseCandidates];
	if (entry.providerID !== 'unknown') {
		const providerPrefix = normalizeOpenCodeProviderID(entry.providerID);
		candidates.push(...baseCandidates.map((candidate) => `${providerPrefix}/${candidate}`));
	}
	return Array.from(new Set(candidates));
}

async function calculateCostForEntry(
	entry: LoadedUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	if (entry.costUSD != null && entry.costUSD > 0) {
		return entry.costUSD;
	}

	const tokens = {
		input_tokens: entry.usage.inputTokens,
		output_tokens: entry.usage.outputTokens,
		cache_creation_input_tokens: entry.usage.cacheCreationInputTokens,
		cache_read_input_tokens: entry.usage.cacheReadInputTokens,
	};

	for (const candidate of createModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}

export async function loadOpenCodeRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const entries = await loadOpenCodeMessages();
	const ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({ offline: options.offline === true, logger })
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher!;
	try {
		const groups = new Map<string, { row: AgentUsageRow; models: Set<string> }>();

		for (const entry of entries) {
			const date = formatDateKey(entry.timestamp.toISOString(), options.timezone);
			if (!isWithinRange(date, since, until)) {
				continue;
			}
			const period =
				kind === 'session' ? entry.sessionID : kind === 'monthly' ? date.slice(0, 7) : date;
			const group = groups.get(period) ?? {
				row: createEmptyRow(period, 'opencode'),
				models: new Set(),
			};
			if (!groups.has(period)) {
				groups.set(period, group);
			}
			group.row.inputTokens += entry.usage.inputTokens;
			group.row.outputTokens += entry.usage.outputTokens;
			group.row.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			group.row.cacheReadTokens += entry.usage.cacheReadInputTokens;
			group.row.totalTokens +=
				entry.usage.inputTokens +
				entry.usage.outputTokens +
				entry.usage.cacheCreationInputTokens +
				entry.usage.cacheReadInputTokens;
			group.row.totalCost += await calculateCostForEntry(entry, fetcher);
			group.models.add(entry.model);
		}

		return Array.from(groups.values(), ({ row, models }) => ({
			...row,
			modelsUsed: Array.from(models).sort(compareStrings),
		})).sort((a, b) => compareStrings(a.period, b.period));
	} finally {
		ownedFetcher?.[Symbol.dispose]();
	}
}
