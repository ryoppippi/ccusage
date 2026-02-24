/**
 * @fileoverview Factory Droid log loader.
 *
 * Parses `droid-log-*.log` files, extracts cumulative token counters, converts them
 * into per-interval deltas, and resolves model identifiers (including custom models).
 */

import type { ModelIdSource, TokenUsageEvent } from './_types.ts';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { DROID_LOG_GLOB, FACTORY_LOGS_SUBDIR, FACTORY_SESSIONS_SUBDIR } from './_consts.ts';
import { loadFactoryCustomModels, resolveFactoryDir } from './factory-settings.ts';
import { logger } from './logger.ts';
import { createEmptyUsage, subtractUsage, toTotalTokens } from './token-utils.ts';

/**
 * Normalizes unknown errors into `Error` instances.
 */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

type ParsedSessionSettings = {
	timestamp: string;
	sessionId: string;
	settingsPath: string;
	modelId: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		thinkingTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
};

const recordSchema = v.record(v.string(), v.unknown());

const tokenUsageSchema = v.object({
	inputTokens: v.optional(v.number()),
	outputTokens: v.optional(v.number()),
	thinkingTokens: v.optional(v.number()),
	cacheReadTokens: v.optional(v.number()),
	cacheCreationTokens: v.optional(v.number()),
});

const sessionValueSchema = v.object({
	sessionId: v.string(),
	path: v.string(),
	hasTokenUsage: v.optional(v.boolean()),
	tokenUsage: v.optional(tokenUsageSchema),
});

const sessionContextSchema = v.object({
	value: sessionValueSchema,
	tags: v.optional(recordSchema),
});

const sessionSettingsSchema = v.object({
	model: v.optional(v.string()),
});

/**
 * Returns a trimmed string if it is non-empty, otherwise `undefined`.
 */
function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * Extracts an ISO timestamp from a log line prefix like `[2026-01-01T00:00:00Z]`.
 */
function extractTimestampFromLogLine(line: string): string | undefined {
	if (!line.startsWith('[')) {
		return undefined;
	}
	const end = line.indexOf(']');
	if (end === -1) {
		return undefined;
	}
	const raw = line.slice(1, end).trim();
	return raw === '' ? undefined : raw;
}

/**
 * Derives a stable "project key" from a settings path under `.../sessions/<project>/...`.
 */
function extractProjectKeyFromSettingsPath(settingsPath: string): string {
	const normalized = path.normalize(settingsPath);
	const segments = normalized.split(path.sep);
	const sessionsIndex = segments.findIndex((segment) => segment === FACTORY_SESSIONS_SUBDIR);
	if (sessionsIndex === -1 || sessionsIndex + 1 >= segments.length) {
		return 'unknown';
	}

	const projectKey = segments[sessionsIndex + 1];
	return projectKey != null && projectKey.trim() !== '' ? projectKey : 'unknown';
}

type ModelIdCacheEntry = {
	mtimeMs: number;
	modelId: string | null;
};

/**
 * Loads the model ID from a per-session settings file (`*.settings.json`).
 *
 * Results are cached by `(settingsPath, mtimeMs)`.
 */
async function loadModelIdFromSessionSettings(
	settingsPath: string,
	cache: Map<string, ModelIdCacheEntry>,
): Promise<string | undefined> {
	const statResult = await Result.try({
		try: stat(settingsPath),
		catch: (error) => toError(error),
	});
	if (Result.isFailure(statResult) || !statResult.value.isFile()) {
		return undefined;
	}

	const mtimeMs = statResult.value.mtimeMs;
	const cached = cache.get(settingsPath);
	if (cached != null && cached.mtimeMs === mtimeMs) {
		return cached.modelId ?? undefined;
	}

	const raw = await Result.try({
		try: readFile(settingsPath, 'utf8'),
		catch: (error) => toError(error),
	});
	if (Result.isFailure(raw)) {
		return undefined;
	}

	const parsedJson = Result.try({
		try: () => JSON.parse(raw.value) as unknown,
		catch: (error) => toError(error),
	})();
	if (Result.isFailure(parsedJson)) {
		return undefined;
	}

	const parsed = v.safeParse(sessionSettingsSchema, parsedJson.value);
	if (!parsed.success) {
		return undefined;
	}

	const modelId = asNonEmptyString(parsed.output.model) ?? null;
	cache.set(settingsPath, { mtimeMs, modelId });
	return modelId ?? undefined;
}

/**
 * Parses a single Factory Droid log line that contains session settings.
 *
 * Returns `null` for unrelated lines or malformed payloads.
 */
export function parseSessionSettingsLogLine(line: string): ParsedSessionSettings | null {
	if (!line.includes('[Session] Saving session settings')) {
		return null;
	}

	const timestamp = extractTimestampFromLogLine(line);
	if (timestamp == null) {
		return null;
	}

	const contextIndex = line.indexOf('| Context:');
	if (contextIndex === -1) {
		return null;
	}
	const contextRaw = line.slice(contextIndex + '| Context:'.length).trim();
	if (contextRaw === '') {
		return null;
	}

	const jsonResult = Result.try({
		try: () => JSON.parse(contextRaw) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(jsonResult)) {
		return null;
	}

	const parsed = v.safeParse(sessionContextSchema, jsonResult.value);
	if (!parsed.success) {
		return null;
	}

	const payload = parsed.output;
	const value = payload.value;
	if (value.hasTokenUsage === false) {
		return null;
	}

	const tokenUsage = value.tokenUsage;
	if (tokenUsage == null) {
		return null;
	}

	const modelId =
		asNonEmptyString(payload.tags?.modelId) ?? asNonEmptyString(payload.tags?.model) ?? 'unknown';

	return {
		timestamp,
		sessionId: value.sessionId,
		settingsPath: value.path,
		modelId,
		usage: {
			inputTokens: tokenUsage.inputTokens ?? 0,
			outputTokens: tokenUsage.outputTokens ?? 0,
			thinkingTokens: tokenUsage.thinkingTokens ?? 0,
			cacheReadTokens: tokenUsage.cacheReadTokens ?? 0,
			cacheCreationTokens: tokenUsage.cacheCreationTokens ?? 0,
		},
	};
}

/**
 * Options for loading Factory Droid events.
 */
export type LoadFactoryOptions = {
	factoryDir?: string;
};

/**
 * Result of loading Factory Droid events.
 */
export type LoadFactoryResult = {
	events: TokenUsageEvent[];
	missingLogsDirectory: string | null;
};

/**
 * Loads token usage events from Factory Droid logs.
 *
 * - Reads log files from `~/.factory/logs` (or a provided `factoryDir`)
 * - Parses session settings lines with cumulative counters
 * - Computes deltas per session, treating counter decreases as resets
 */
export async function loadFactoryTokenUsageEvents(
	options: LoadFactoryOptions = {},
): Promise<LoadFactoryResult> {
	const factoryDir = resolveFactoryDir(options.factoryDir);
	const logsDir = path.join(factoryDir, FACTORY_LOGS_SUBDIR);
	if (!isDirectorySync(logsDir)) {
		return { events: [], missingLogsDirectory: logsDir };
	}

	const customModels = await loadFactoryCustomModels(factoryDir);
	const logPaths = await glob(DROID_LOG_GLOB, {
		cwd: logsDir,
		absolute: true,
	});

	const logFileStats = await Promise.all(
		logPaths.map(async (filePath) => {
			const statResult = await Result.try({
				try: stat(filePath),
				catch: (error) => toError(error),
			});
			if (Result.isFailure(statResult)) {
				return null;
			}
			if (!statResult.value.isFile()) {
				return null;
			}
			return { filePath, mtimeMs: statResult.value.mtimeMs };
		}),
	);

	const sortedPaths = logFileStats
		.filter((entry): entry is { filePath: string; mtimeMs: number } => entry != null)
		.sort((a, b) => a.mtimeMs - b.mtimeMs)
		.map((entry) => entry.filePath);

	const previousTotals = new Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			thinkingTokens: number;
			cacheReadTokens: number;
			cacheCreationTokens: number;
			totalTokens: number;
		}
	>();

	const lastKnownModelIdBySessionId = new Map<string, string>();
	const modelIdBySettingsPathCache = new Map<string, ModelIdCacheEntry>();

	const events: TokenUsageEvent[] = [];

	for (const logPath of sortedPaths) {
		const stream = createReadStream(logPath, { encoding: 'utf8' });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				const parsed = parseSessionSettingsLogLine(line);
				if (parsed == null) {
					continue;
				}

				let modelId = parsed.modelId;
				let modelIdSource: ModelIdSource = 'unknown';
				if (modelId === 'unknown') {
					const modelIdFromSettings = await loadModelIdFromSessionSettings(
						parsed.settingsPath,
						modelIdBySettingsPathCache,
					);
					if (modelIdFromSettings != null) {
						modelId = modelIdFromSettings;
						modelIdSource = 'settings';
						lastKnownModelIdBySessionId.set(parsed.sessionId, modelId);
					} else {
						const previousModelId = lastKnownModelIdBySessionId.get(parsed.sessionId);
						if (previousModelId != null) {
							modelId = previousModelId;
							modelIdSource = 'session';
						}
					}
				} else {
					modelIdSource = 'tag';
					lastKnownModelIdBySessionId.set(parsed.sessionId, modelId);
				}

				const model = customModels.get(modelId);
				const pricingModel = model?.model ?? modelId;

				const current = parsed.usage;
				const currentTotals = {
					...current,
					totalTokens: toTotalTokens(current),
				};
				const previous = previousTotals.get(parsed.sessionId) ?? createEmptyUsage();
				const delta = subtractUsage(current, previous);

				if (delta.totalTokens <= 0) {
					previousTotals.set(parsed.sessionId, currentTotals);
					continue;
				}

				previousTotals.set(parsed.sessionId, currentTotals);

				events.push({
					timestamp: parsed.timestamp,
					sessionId: parsed.sessionId,
					projectKey: extractProjectKeyFromSettingsPath(parsed.settingsPath),
					modelId,
					modelIdSource,
					pricingModel,
					inputTokens: delta.inputTokens,
					outputTokens: delta.outputTokens,
					thinkingTokens: delta.thinkingTokens,
					cacheReadTokens: delta.cacheReadTokens,
					cacheCreationTokens: delta.cacheCreationTokens,
					totalTokens: delta.totalTokens,
				});
			}
		} catch (error) {
			logger.debug('Failed to read Factory log file', logPath, error);
		} finally {
			rl.close();
			stream.destroy();
		}
	}

	return { events, missingLogsDirectory: null };
}

if (import.meta.vitest != null) {
	describe('loadFactoryTokenUsageEvents', () => {
		it('parses session settings lines and computes deltas', async () => {
			const fixture = await createFixture({
				'settings.json': JSON.stringify(
					{
						customModels: [{ id: 'custom:Test-0', model: 'gpt-5.2', provider: 'openai' }],
					},
					null,
					2,
				),
				'logs/droid-log-single.log': [
					`[2026-01-01T00:00:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
						{
							value: {
								sessionId: 's1',
								path: '/Users/me/.factory/sessions/-Users-me-proj/s1.settings.json',
								hasTokenUsage: true,
								tokenUsage: {
									inputTokens: 10,
									outputTokens: 5,
									thinkingTokens: 2,
									cacheReadTokens: 100,
									cacheCreationTokens: 3,
								},
							},
							tags: { modelId: 'custom:Test-0' },
						},
					)}`,
					`[2026-01-01T00:01:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
						{
							value: {
								sessionId: 's1',
								path: '/Users/me/.factory/sessions/-Users-me-proj/s1.settings.json',
								hasTokenUsage: true,
								tokenUsage: {
									inputTokens: 15,
									outputTokens: 7,
									thinkingTokens: 2,
									cacheReadTokens: 130,
									cacheCreationTokens: 4,
								},
							},
							tags: { modelId: 'custom:Test-0' },
						},
					)}`,
				].join('\n'),
			});

			const result = await loadFactoryTokenUsageEvents({ factoryDir: fixture.path });
			expect(result.missingLogsDirectory).toBeNull();
			expect(result.events).toHaveLength(2);
			expect(result.events[0]?.pricingModel).toBe('gpt-5.2');
			expect(result.events[0]?.totalTokens).toBe(10 + 5 + 2 + 100 + 3);
			expect(result.events[1]?.inputTokens).toBe(5);
			expect(result.events[1]?.cacheReadTokens).toBe(30);
		});

		it('treats token counter resets as new totals', async () => {
			const fixture = await createFixture({
				'logs/droid-log-single.log': [
					`[2026-01-01T00:00:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
						{
							value: {
								sessionId: 's2',
								path: '/Users/me/.factory/sessions/-Users-me-proj/s2.settings.json',
								hasTokenUsage: true,
								tokenUsage: { inputTokens: 100, outputTokens: 50 },
							},
							tags: { modelId: 'gpt-5.2' },
						},
					)}`,
					`[2026-01-01T00:01:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
						{
							value: {
								sessionId: 's2',
								path: '/Users/me/.factory/sessions/-Users-me-proj/s2.settings.json',
								hasTokenUsage: true,
								tokenUsage: { inputTokens: 20, outputTokens: 10 },
							},
							tags: { modelId: 'gpt-5.2' },
						},
					)}`,
				].join('\n'),
			});

			const result = await loadFactoryTokenUsageEvents({ factoryDir: fixture.path });
			expect(result.events).toHaveLength(2);
			expect(result.events[0]?.inputTokens).toBe(100);
			expect(result.events[1]?.inputTokens).toBe(20);
		});

		it('reuses last known model id when tags omit modelId', async () => {
			const fixture = await createFixture({
				'logs/droid-log-single.log': [
					`[2026-01-01T00:00:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
						{
							value: {
								sessionId: 's3',
								path: '/Users/me/.factory/sessions/-Users-me-proj/s3.settings.json',
								hasTokenUsage: true,
								tokenUsage: { inputTokens: 10, outputTokens: 0 },
							},
							tags: { modelId: 'gpt-5.2' },
						},
					)}`,
					`[2026-01-01T00:01:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
						{
							value: {
								sessionId: 's3',
								path: '/Users/me/.factory/sessions/-Users-me-proj/s3.settings.json',
								hasTokenUsage: true,
								tokenUsage: { inputTokens: 20, outputTokens: 0 },
							},
						},
					)}`,
				].join('\n'),
			});

			const result = await loadFactoryTokenUsageEvents({ factoryDir: fixture.path });
			expect(result.events).toHaveLength(2);
			expect(result.events[1]?.modelId).toBe('gpt-5.2');
			expect(result.events[1]?.modelIdSource).toBe('session');
			expect(result.events[1]?.pricingModel).toBe('gpt-5.2');
		});

		it('uses model from session settings file when tags omit modelId', async () => {
			const fixture = await createFixture({
				'sessions/proj/s4.settings.json': JSON.stringify(
					{
						model: 'gpt-5.2',
						tokenUsage: { inputTokens: 0, outputTokens: 0 },
					},
					null,
					2,
				),
				'logs/droid-log-single.log': '',
			});

			const settingsPath = path.join(fixture.path, 'sessions/proj/s4.settings.json');
			const logPath = path.join(fixture.path, 'logs/droid-log-single.log');
			await writeFile(
				logPath,
				`[2026-01-01T00:00:00.000Z] INFO: [Session] Saving session settings | Context: ${JSON.stringify(
					{
						value: {
							sessionId: 's4',
							path: settingsPath,
							hasTokenUsage: true,
							tokenUsage: { inputTokens: 10, outputTokens: 5 },
						},
					},
				)}`,
				'utf8',
			);

			const result = await loadFactoryTokenUsageEvents({ factoryDir: fixture.path });
			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.projectKey).toBe('proj');
			expect(result.events[0]?.modelId).toBe('gpt-5.2');
			expect(result.events[0]?.modelIdSource).toBe('settings');
			expect(result.events[0]?.pricingModel).toBe('gpt-5.2');
		});
	});
}
