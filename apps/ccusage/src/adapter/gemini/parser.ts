import type { GeminiUsageEvent } from './schema.ts';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readTextFile } from '@ccusage/internal/fs';
import { processJSONLFileByLine } from '@ccusage/internal/jsonl';
import { compareStrings } from '@ccusage/internal/sort';
import { getDefaultWorkerThreadCount, mapWithConcurrency } from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { discoverGeminiLogFiles, GEMINI_DATA_DIR_ENV } from './paths.ts';

type JsonRecord = Record<string, unknown>;
type GeminiTokens = {
	input: number;
	output: number;
	cached: number;
	thoughts: number;
	tool: number;
	total?: number;
};

function asRecord(value: unknown): JsonRecord | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tokenNumber(record: JsonRecord, keys: string[]): number {
	for (const key of keys) {
		const value = asNumber(record[key]);
		if (value != null) {
			return Math.max(value, 0);
		}
	}
	return 0;
}

function parseTimestamp(value: unknown): string | undefined {
	const raw = asString(value);
	if (raw == null) {
		return undefined;
	}
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function getFallbackTimestamp(filePath: string): Promise<string> {
	try {
		const stats = await stat(filePath);
		return stats.mtime.toISOString();
	} catch {
		return new Date(0).toISOString();
	}
}

function parseGeminiTokens(value: unknown): GeminiTokens | null {
	const record = asRecord(value);
	if (record == null) {
		return null;
	}
	return {
		input: tokenNumber(record, ['input', 'prompt', 'input_tokens', 'prompt_tokens']),
		output: tokenNumber(record, ['output', 'candidates', 'output_tokens', 'candidates_tokens']),
		cached: tokenNumber(record, ['cached', 'cached_tokens']),
		thoughts: tokenNumber(record, ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens']),
		tool: tokenNumber(record, ['tool', 'tool_tokens']),
		total: asNumber(record.total),
	};
}

function subtractCachedOverlap(
	input: number,
	cached: number,
): { input: number; cacheRead: number } {
	const cacheRead = Math.max(cached, 0);
	const cachedPortion = Math.min(Math.max(input, 0), cacheRead);
	return {
		input: Math.max(input, 0) - cachedPortion,
		cacheRead,
	};
}

function normalizeSessionInput(tokens: GeminiTokens): { input: number; cacheRead: number } {
	const inclusiveTotal = tokens.input + tokens.output + tokens.thoughts + tokens.tool;
	const exclusiveTotal = inclusiveTotal + tokens.cached;
	if (tokens.cached > 0 && tokens.total === inclusiveTotal && tokens.total !== exclusiveTotal) {
		return subtractCachedOverlap(tokens.input, tokens.cached);
	}
	return {
		input: tokens.input,
		cacheRead: tokens.cached,
	};
}

function buildEvent(
	model: string | undefined,
	sessionId: string,
	timestamp: string,
	tokens: GeminiTokens,
	normalizeInput: (tokens: GeminiTokens) => { input: number; cacheRead: number },
): GeminiUsageEvent | null {
	if (model == null) {
		return null;
	}
	const normalized = normalizeInput(tokens);
	const inputTokens = normalized.input + tokens.tool;
	const totalTokens =
		tokens.total == null
			? inputTokens + tokens.output + normalized.cacheRead + tokens.thoughts
			: Math.max(tokens.total, 0);
	if (
		inputTokens === 0 &&
		tokens.output === 0 &&
		normalized.cacheRead === 0 &&
		tokens.thoughts === 0
	) {
		return null;
	}
	return {
		timestamp,
		sessionId,
		model,
		inputTokens,
		outputTokens: tokens.output,
		cacheReadTokens: normalized.cacheRead,
		reasoningTokens: tokens.thoughts,
		toolTokens: tokens.tool,
		totalTokens,
	};
}

function parseStatsEvents(
	statsValue: unknown,
	modelHint: string | undefined,
	sessionId: string,
	timestamp: string,
): GeminiUsageEvent[] {
	const stats = asRecord(statsValue);
	if (stats == null) {
		return [];
	}
	const models = asRecord(stats.models);
	if (models != null) {
		const events: GeminiUsageEvent[] = [];
		for (const [model, data] of Object.entries(models)) {
			const dataRecord = asRecord(data);
			const tokens = parseGeminiTokens(dataRecord?.tokens);
			if (tokens == null) {
				continue;
			}
			const event = buildEvent(model, sessionId, timestamp, tokens, (item) =>
				subtractCachedOverlap(item.input, item.cached),
			);
			if (event != null) {
				events.push(event);
			}
		}
		if (events.length > 0) {
			return events;
		}
	}
	const tokens = parseGeminiTokens(stats);
	if (tokens == null) {
		return [];
	}
	const event = buildEvent(modelHint ?? 'unknown', sessionId, timestamp, tokens, (item) =>
		subtractCachedOverlap(item.input, item.cached),
	);
	return event == null ? [] : [event];
}

function parseDirectEvent(
	value: JsonRecord,
	modelHint: string | undefined,
	sessionId: string,
	fallbackTimestamp: string,
): GeminiUsageEvent | null {
	const tokens = parseGeminiTokens(value.tokens);
	if (tokens == null) {
		return null;
	}
	return buildEvent(
		asString(value.model) ?? modelHint,
		sessionId,
		parseTimestamp(value.timestamp) ?? parseTimestamp(value.created_at) ?? fallbackTimestamp,
		tokens,
		normalizeSessionInput,
	);
}

async function parseGeminiJsonFile(filePath: string): Promise<GeminiUsageEvent[]> {
	const fallbackTimestamp = await getFallbackTimestamp(filePath);
	const readResult = await Result.try({
		try: readTextFile(filePath),
		catch: (error) => error,
	});
	if (Result.isFailure(readResult)) {
		return [];
	}
	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(parseResult)) {
		return [];
	}
	const value = asRecord(parseResult.value);
	if (value == null) {
		return [];
	}

	const sessionId =
		asString(value.sessionId) ??
		asString(value.session_id) ??
		path.basename(filePath, path.extname(filePath));
	const sessionTimestamp =
		parseTimestamp(value.startTime) ?? parseTimestamp(value.lastUpdated) ?? fallbackTimestamp;
	const messages = Array.isArray(value.messages) ? value.messages : undefined;
	if (messages != null) {
		const events: GeminiUsageEvent[] = [];
		for (const message of messages) {
			const record = asRecord(message);
			if (record?.type !== 'gemini') {
				continue;
			}
			const event = parseDirectEvent(record, undefined, sessionId, sessionTimestamp);
			if (event != null) {
				events.push(event);
			}
		}
		return events;
	}

	if (value.type === 'gemini') {
		const event = parseDirectEvent(value, undefined, sessionId, fallbackTimestamp);
		return event == null ? [] : [event];
	}

	const stats = value.stats ?? asRecord(value.result)?.stats;
	return parseStatsEvents(
		stats,
		asString(value.model),
		sessionId,
		parseTimestamp(value.timestamp) ?? fallbackTimestamp,
	);
}

async function parseGeminiJsonlFile(filePath: string): Promise<GeminiUsageEvent[]> {
	const fallbackTimestamp = await getFallbackTimestamp(filePath);
	let sessionId = path.basename(filePath, path.extname(filePath));
	let currentModel: string | undefined;
	const events: GeminiUsageEvent[] = [];
	const directEventIndexes = new Map<string, number>();
	const result = await Result.try({
		try: processJSONLFileByLine(filePath, (line) => {
			const parseResult = Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) => error,
			})();
			if (Result.isFailure(parseResult)) {
				return;
			}
			const value = asRecord(parseResult.value);
			if (value == null) {
				return;
			}
			sessionId = asString(value.sessionId) ?? asString(value.session_id) ?? sessionId;
			currentModel = asString(value.model) ?? currentModel;

			if (value.type === 'gemini') {
				const event = parseDirectEvent(value, currentModel, sessionId, fallbackTimestamp);
				if (event == null) {
					return;
				}
				const id = asString(value.id);
				if (id == null) {
					events.push(event);
					return;
				}
				const existingIndex = directEventIndexes.get(id);
				if (existingIndex == null) {
					directEventIndexes.set(id, events.length);
					events.push(event);
					return;
				}
				events[existingIndex] = event;
				return;
			}

			const stats = value.stats ?? asRecord(value.result)?.stats;
			if (stats != null) {
				events.push(
					...parseStatsEvents(
						stats,
						currentModel,
						sessionId,
						parseTimestamp(value.timestamp) ?? fallbackTimestamp,
					),
				);
			}
		}),
		catch: (error) => error,
	});
	return Result.isFailure(result) ? [] : events;
}

export async function loadGeminiUsageEvents(): Promise<GeminiUsageEvent[]> {
	const files = await discoverGeminiLogFiles();
	const eventGroups = await mapWithConcurrency(
		files,
		getDefaultWorkerThreadCount(files.length),
		async (filePath) =>
			filePath.endsWith('.jsonl') ? parseGeminiJsonlFile(filePath) : parseGeminiJsonFile(filePath),
	);
	return eventGroups.flat().sort((a, b) => compareStrings(a.timestamp, b.timestamp));
}

if (import.meta.vitest != null) {
	describe('loadGeminiUsageEvents', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads Gemini JSONL token events and separates cached input', async () => {
			await using fixture = await createFixture({
				project: {
					chats: {
						'session-a.jsonl': [
							JSON.stringify({
								sessionId: 'session-a',
								projectHash: 'project-a',
								startTime: '2026-05-17T11:07:00.000Z',
							}),
							JSON.stringify({
								id: 'msg-a',
								timestamp: '2026-05-17T11:07:32.000Z',
								type: 'gemini',
								model: 'gemini-3-flash-preview',
								tokens: {
									input: 15_327,
									output: 23,
									cached: 11_526,
									thoughts: 919,
									tool: 7,
									total: 16_276,
								},
							}),
						].join('\n'),
					},
				},
			});
			vi.stubEnv(GEMINI_DATA_DIR_ENV, fixture.path);

			await expect(loadGeminiUsageEvents()).resolves.toEqual([
				{
					timestamp: '2026-05-17T11:07:32.000Z',
					sessionId: 'session-a',
					model: 'gemini-3-flash-preview',
					inputTokens: 3_808,
					outputTokens: 23,
					cacheReadTokens: 11_526,
					reasoningTokens: 919,
					toolTokens: 7,
					totalTokens: 16_276,
				},
			]);
		});
	});
}
