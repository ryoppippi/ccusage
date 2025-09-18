import type { TokenUsageDelta, TokenUsageEvent } from './_types.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import { CODEX_HOME_ENV, DEFAULT_CODEX_DIR, DEFAULT_SESSION_SUBDIR, SESSION_GLOB } from './_consts.ts';
import { logger } from './logger.ts';

type RawUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
};

function ensureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeRawUsage(value: unknown): RawUsage | null {
	if (value == null || typeof value !== 'object') {
		return null;
	}

	const record = value as Record<string, unknown>;
	const input = ensureNumber(record.input_tokens);
	const cached = ensureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
	const output = ensureNumber(record.output_tokens);
	const reasoning = ensureNumber(record.reasoning_output_tokens);
	const total = ensureNumber(record.total_tokens);

	return {
		input_tokens: input,
		cached_input_tokens: cached,
		output_tokens: output,
		reasoning_output_tokens: reasoning,
		total_tokens: total > 0 ? total : input + output + reasoning,
	};
}

function subtractRawUsage(current: RawUsage, previous: RawUsage | null): RawUsage {
	return {
		input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
		cached_input_tokens: Math.max(current.cached_input_tokens - (previous?.cached_input_tokens ?? 0), 0),
		output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
		reasoning_output_tokens: Math.max(current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0), 0),
		total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
	};
}

function convertToDelta(raw: RawUsage): TokenUsageDelta {
	const total = raw.total_tokens > 0
		? raw.total_tokens
		: raw.input_tokens + raw.output_tokens + raw.reasoning_output_tokens;

	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);

	return {
		inputTokens: raw.input_tokens,
		cachedInputTokens: cached,
		outputTokens: raw.output_tokens,
		reasoningOutputTokens: raw.reasoning_output_tokens,
		totalTokens: total,
	};
}

function extractModel(value: unknown): string | undefined {
	if (value == null || typeof value !== 'object') {
		return undefined;
	}

	const payload = value as Record<string, unknown>;
	const info = payload.info;
	if (typeof info === 'object' && info != null) {
		const infoRecord = info as Record<string, unknown>;
		const modelCandidates = [
			infoRecord.model,
			infoRecord.model_name,
			(infoRecord.metadata as Record<string, unknown> | undefined)?.model,
		];

		for (const candidate of modelCandidates) {
			if (typeof candidate === 'string' && candidate.trim() !== '') {
				return candidate;
			}
		}
	}

	const candidate = payload.model ?? (payload.metadata as Record<string, unknown> | undefined)?.model;
	return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined;
}

export type LoadOptions = {
	sessionDirs?: string[];
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
};

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const providedDirs = options.sessionDirs != null && options.sessionDirs.length > 0
		? options.sessionDirs.map(dir => path.resolve(dir))
		: undefined;

	const codexHomeEnv = process.env[CODEX_HOME_ENV]?.trim();
	const codexHome = codexHomeEnv != null && codexHomeEnv !== ''
		? path.resolve(codexHomeEnv)
		: DEFAULT_CODEX_DIR;
	const defaultSessionsDir = path.join(codexHome, DEFAULT_SESSION_SUBDIR);
	const sessionDirs = providedDirs ?? [defaultSessionsDir];

	const events: TokenUsageEvent[] = [];
	const missingDirectories: string[] = [];

	for (const dir of sessionDirs) {
		const directoryPath = path.resolve(dir);
		const statResult = await Result.try({
			try: stat(directoryPath),
			catch: error => error,
		});

		if (Result.isFailure(statResult)) {
			missingDirectories.push(directoryPath);
			continue;
		}

		if (!statResult.value.isDirectory()) {
			missingDirectories.push(directoryPath);
			continue;
		}

		const files = await glob(SESSION_GLOB, {
			cwd: directoryPath,
			absolute: true,
		});

		for (const file of files) {
			const fileContentResult = await Result.try({
				try: readFile(file, 'utf8'),
				catch: error => error,
			});

			if (Result.isFailure(fileContentResult)) {
				logger.debug('Failed to read Codex session file', fileContentResult.error);
				continue;
			}

			let previousTotals: RawUsage | null = null;
			let currentModel: string | undefined;
			const lines = fileContentResult.value.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === '') {
					continue;
				}

				const parseLine = Result.try({
					try: () => JSON.parse(trimmed) as Record<string, unknown>,
					catch: error => error,
				});
				const parsedResult = parseLine();

				if (Result.isFailure(parsedResult)) {
					continue;
				}

				const entry = parsedResult.value;
				if (entry == null || typeof entry !== 'object') {
					continue;
				}

				const entryType = entry.type as string | undefined;

				if (entryType === 'turn_context') {
					const contextPayload = entry.payload as Record<string, unknown> | undefined;
					const contextModel = extractModel(contextPayload);
					if (contextModel != null) {
						currentModel = contextModel;
					}
					continue;
				}

				if (entryType !== 'event_msg') {
					continue;
				}

				const payload = entry.payload as Record<string, unknown> | undefined;
				if (payload?.type !== 'token_count') {
					continue;
				}

				const timestamp = entry.timestamp;
				if (typeof timestamp !== 'string') {
					continue;
				}

				const info = payload.info as Record<string, unknown> | undefined;
				const lastUsage = normalizeRawUsage(info?.last_token_usage);
				const totalUsage = normalizeRawUsage(info?.total_token_usage);

				let raw = lastUsage;
				if (raw == null && totalUsage != null) {
					raw = subtractRawUsage(totalUsage, previousTotals);
				}

				if (totalUsage != null) {
					previousTotals = totalUsage;
				}

				if (raw == null) {
					continue;
				}

				const delta = convertToDelta(raw);
				if (
					delta.inputTokens === 0
					&& delta.cachedInputTokens === 0
					&& delta.outputTokens === 0
					&& delta.reasoningOutputTokens === 0
				) {
					continue;
				}

				const model = extractModel({ ...payload, info }) ?? currentModel;
				if (model == null) {
					logger.debug('Skipping Codex token event without model metadata', { file, timestamp });
					continue;
				}

				events.push({
					timestamp,
					model,
					inputTokens: delta.inputTokens,
					cachedInputTokens: delta.cachedInputTokens,
					outputTokens: delta.outputTokens,
					reasoningOutputTokens: delta.reasoningOutputTokens,
					totalTokens: delta.totalTokens,
				});
			}
		}
	}

	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadTokenUsageEvents', () => {
		it('parses token_count events and skips entries without model metadata', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-11T18:25:30.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-11T18:25:40.670Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 1_200,
										cached_input_tokens: 200,
										output_tokens: 500,
										reasoning_output_tokens: 0,
										total_tokens: 1_700,
									},
									last_token_usage: {
										input_tokens: 1_200,
										cached_input_tokens: 200,
										output_tokens: 500,
										reasoning_output_tokens: 0,
										total_tokens: 1_700,
									},
									model: 'gpt-5',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-11T18:40:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T00:00:00.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 2_000,
										cached_input_tokens: 300,
										output_tokens: 800,
										reasoning_output_tokens: 0,
										total_tokens: 2_800,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			expect(await fixture.exists('sessions/project-1.jsonl')).toBe(true);

			const { events, missingDirectories } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});
			expect(missingDirectories).toEqual([]);

			expect(events).toHaveLength(2);
			const first = events[0]!;
			expect(first.model).toBe('gpt-5');
			expect(first.inputTokens).toBe(1_200);
			expect(first.cachedInputTokens).toBe(200);
			const second = events[1]!;
			expect(second.model).toBe('gpt-5');
			expect(second.inputTokens).toBe(800);
			expect(second.cachedInputTokens).toBe(100);
		});
	});
}
