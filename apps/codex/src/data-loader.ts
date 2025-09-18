import type { TokenUsageDelta, TokenUsageEvent } from './_types.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
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

/**
 * Normalize Codex `token_count` payloads into a predictable shape.
 *
 * Codex reports four counters:
 *   - input_tokens
 *   - cached_input_tokens (a.k.a cache_read_input_tokens)
 *   - output_tokens (this already includes any reasoning charge)
 *   - reasoning_output_tokens (informational only)
 *
 * Modern JSONL entries also provide `total_tokens`, but legacy ones may omit it.
 * When that happens we mirror Codex' billing behavior and synthesize
 * `input + output` (reasoning is treated as part of output, not an extra charge).
 */
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
		// LiteLLM pricing treats reasoning tokens as part of the normal output price. Codex
		// includes them as a separate field but does not add them to total_tokens, so when we
		// have to synthesize a total (legacy logs), we mirror that behavior with input+output.
		total_tokens: total > 0 ? total : input + output,
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

/**
 * Convert cumulative usage into a per-event delta.
 *
 * Codex includes the cost of reasoning inside `output_tokens`. The
 * `reasoning_output_tokens` field is useful for display/debug purposes, but we
 * must not add it to the billable output again. For legacy totals we therefore
 * fallback to `input + output`.
 */
function convertToDelta(raw: RawUsage): TokenUsageDelta {
	const total = raw.total_tokens > 0
		? raw.total_tokens
		: raw.input_tokens + raw.output_tokens;

	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);

	return {
		inputTokens: raw.input_tokens,
		cachedInputTokens: cached,
		outputTokens: raw.output_tokens,
		reasoningOutputTokens: raw.reasoning_output_tokens,
		totalTokens: total,
	};
}

const recordSchema = v.record(v.string(), v.unknown());
const LEGACY_FALLBACK_MODEL = 'gpt-5';

const entrySchema = v.object({
	type: v.string(),
	payload: v.optional(v.unknown()),
	timestamp: v.optional(v.string()),
});

const tokenCountPayloadSchema = v.object({
	type: v.literal('token_count'),
	info: v.optional(recordSchema),
});

function extractModel(value: unknown): string | undefined {
	const parsed = v.safeParse(recordSchema, value);
	if (!parsed.success) {
		return undefined;
	}

	const payload = parsed.output;

	const infoCandidate = payload.info;
	if (infoCandidate != null) {
		const infoParsed = v.safeParse(recordSchema, infoCandidate);
		if (infoParsed.success) {
			const info = infoParsed.output;
			const directCandidates = [info.model, info.model_name];
			for (const candidate of directCandidates) {
				const model = asNonEmptyString(candidate);
				if (model != null) {
					return model;
				}
			}

			if (info.metadata != null) {
				const metadataParsed = v.safeParse(recordSchema, info.metadata);
				if (metadataParsed.success) {
					const model = asNonEmptyString(metadataParsed.output.model);
					if (model != null) {
						return model;
					}
				}
			}
		}
	}

	const fallbackModel = asNonEmptyString(payload.model);
	if (fallbackModel != null) {
		return fallbackModel;
	}

	if (payload.metadata != null) {
		const metadataParsed = v.safeParse(recordSchema, payload.metadata);
		if (metadataParsed.success) {
			const model = asNonEmptyString(metadataParsed.output.model);
			if (model != null) {
				return model;
			}
		}
	}

	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
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
			let currentModelIsFallback = false;
			let legacyFallbackUsed = false;
			const lines = fileContentResult.value.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === '') {
					continue;
				}

				const parseLine = Result.try({
					try: () => JSON.parse(trimmed) as unknown,
					catch: error => error,
				});
				const parsedResult = parseLine();

				if (Result.isFailure(parsedResult)) {
					continue;
				}

				const entryParse = v.safeParse(entrySchema, parsedResult.value);
				if (!entryParse.success) {
					continue;
				}

				const { type: entryType, payload, timestamp } = entryParse.output;

				if (entryType === 'turn_context') {
					const contextPayload = v.safeParse(recordSchema, payload ?? null);
					if (contextPayload.success) {
						const contextModel = extractModel(contextPayload.output);
						if (contextModel != null) {
							currentModel = contextModel;
							currentModelIsFallback = false;
						}
					}
					continue;
				}

				if (entryType !== 'event_msg') {
					continue;
				}

				const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, payload ?? undefined);
				if (!tokenPayloadResult.success) {
					continue;
				}

				if (timestamp == null) {
					continue;
				}

				const info = tokenPayloadResult.output.info;
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

				const payloadRecordResult = v.safeParse(recordSchema, payload ?? undefined);
				const extractionSource = payloadRecordResult.success
					? Object.assign({}, payloadRecordResult.output, { info })
					: { info };
				const extractedModel = extractModel(extractionSource);
				let isFallbackModel = false;
				if (extractedModel != null) {
					currentModel = extractedModel;
					currentModelIsFallback = false;
				}

				let model = extractedModel ?? currentModel;
				if (model == null) {
					model = LEGACY_FALLBACK_MODEL;
					isFallbackModel = true;
					legacyFallbackUsed = true;
					currentModel = model;
					currentModelIsFallback = true;
				}
				else if (extractedModel == null && currentModelIsFallback) {
					isFallbackModel = true;
				}

				const event: TokenUsageEvent = {
					timestamp,
					model,
					inputTokens: delta.inputTokens,
					cachedInputTokens: delta.cachedInputTokens,
					outputTokens: delta.outputTokens,
					reasoningOutputTokens: delta.reasoningOutputTokens,
					totalTokens: delta.totalTokens,
				};

				if (isFallbackModel) {
					// Surface the fallback so both table + JSON outputs can annotate pricing that was
					// inferred rather than sourced from the log metadata.
					event.isFallbackModel = true;
				}

				events.push(event);
			}

			if (legacyFallbackUsed) {
				logger.debug('Legacy Codex session lacked model metadata; applied fallback', { file, model: LEGACY_FALLBACK_MODEL });
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

		it('falls back to legacy model when metadata is missing entirely', async () => {
			await using fixture = await createFixture({
				sessions: {
					'legacy.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-15T13:00:00.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 5_000,
										cached_input_tokens: 0,
										output_tokens: 1_000,
										reasoning_output_tokens: 0,
										total_tokens: 6_000,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});
			expect(events).toHaveLength(1);
			expect(events[0]!.model).toBe('gpt-5');
			expect(events[0]!.isFallbackModel).toBe(true);
		});
	});
}
