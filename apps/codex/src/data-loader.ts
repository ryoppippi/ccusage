import type { Stats } from 'node:fs';
import type { TokenUsageDelta, TokenUsageEvent } from './_types.ts';
import { createReadStream } from 'node:fs';
import { stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import {
	CODEX_HOME_ENV,
	DEFAULT_CODEX_DIR,
	DEFAULT_SESSION_SUBDIR,
	SESSION_GLOB,
} from './_consts.ts';
import { isWithinRange, toDateKey } from './date-utils.ts';
import { logger } from './logger.ts';

type RawUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
};

type JsonRecord = Record<string, unknown>;

type SessionParseState = {
	previousTotals: RawUsage | null;
	currentModel?: string;
	currentModelIsFallback: boolean;
	legacyFallbackUsed: boolean;
};

type SessionFileCandidate = {
	file: string;
	relativeSessionPath: string;
	sessionId: string;
};

type SessionFileEntry = SessionFileCandidate & {
	fileStats: Stats;
	metadataId: string;
	forkedFromId?: string;
	shouldCollectEvents: boolean;
};

type ParsedTokenUsageResult = {
	event?: TokenUsageEvent;
	cumulativeTotalTokens?: number;
};

function isRecord(value: unknown): value is JsonRecord {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

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
	if (!isRecord(value)) {
		return null;
	}

	const input = ensureNumber(value.input_tokens);
	const cached = ensureNumber(value.cached_input_tokens ?? value.cache_read_input_tokens);
	const output = ensureNumber(value.output_tokens);
	const reasoning = ensureNumber(value.reasoning_output_tokens);
	const total = ensureNumber(value.total_tokens);

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
		cached_input_tokens: Math.max(
			current.cached_input_tokens - (previous?.cached_input_tokens ?? 0),
			0,
		),
		output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
		reasoning_output_tokens: Math.max(
			current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0),
			0,
		),
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
	const total = raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens;

	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);

	return {
		inputTokens: raw.input_tokens,
		cachedInputTokens: cached,
		outputTokens: raw.output_tokens,
		reasoningOutputTokens: raw.reasoning_output_tokens,
		totalTokens: total,
	};
}

const LEGACY_FALLBACK_MODEL = 'gpt-5';

function extractModelMetadata(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return asNonEmptyString(value.model);
}

function extractModel(value: unknown, infoOverride?: JsonRecord): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const info = infoOverride ?? (isRecord(value.info) ? value.info : undefined);
	if (info != null) {
		for (const candidate of [info.model, info.model_name]) {
			const model = asNonEmptyString(candidate);
			if (model != null) {
				return model;
			}
		}

		const metadataModel = extractModelMetadata(info.metadata);
		if (metadataModel != null) {
			return metadataModel;
		}
	}

	const fallbackModel = asNonEmptyString(value.model);
	if (fallbackModel != null) {
		return fallbackModel;
	}

	return extractModelMetadata(value.metadata);
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function dateToDateKey(value: Date, timezone?: string): string | undefined {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		return undefined;
	}

	return toDateKey(value.toISOString(), timezone);
}

function sessionPathDateKey(relativeSessionPath: string): string | undefined {
	const match = relativeSessionPath.match(/(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\//);
	if (match == null) {
		return undefined;
	}

	const [, year, month, day] = match;
	return `${year}-${month}-${day}`;
}

function shouldReadSessionFile(
	relativeSessionPath: string,
	fileStats: Stats,
	since?: string,
	until?: string,
	timezone?: string,
): boolean {
	if (since == null && until == null) {
		return true;
	}

	const endDateKey = dateToDateKey(fileStats.mtime, timezone);
	if (since != null && endDateKey != null && endDateKey < since) {
		return false;
	}

	const startDateKey =
		sessionPathDateKey(relativeSessionPath) ?? dateToDateKey(fileStats.birthtime, timezone);
	if (until != null && startDateKey != null && startDateKey > until) {
		return false;
	}

	return true;
}

function isRelevantLogLine(line: string): boolean {
	return line.includes('"type"') && (line.includes('turn_context') || line.includes('event_msg'));
}

function isEventWithinRange(
	timestamp: string,
	since?: string,
	until?: string,
	timezone?: string,
): boolean {
	if (since == null && until == null) {
		return true;
	}

	return isWithinRange(toDateKey(timestamp, timezone), since, until);
}

function parseTokenUsageEvent(
	sessionId: string,
	line: string,
	state: SessionParseState,
): ParsedTokenUsageResult | undefined {
	const trimmed = line.trim();
	if (trimmed === '' || !isRelevantLogLine(trimmed)) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}

	if (!isRecord(parsed)) {
		return undefined;
	}

	const entryType = asNonEmptyString(parsed.type);
	if (entryType == null) {
		return undefined;
	}

	const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
	if (entryType === 'turn_context') {
		const contextModel = extractModel(payload);
		if (contextModel != null) {
			state.currentModel = contextModel;
			state.currentModelIsFallback = false;
		}
		return undefined;
	}

	if (entryType !== 'event_msg' || payload == null) {
		return undefined;
	}

	if (asNonEmptyString(payload.type) !== 'token_count') {
		return undefined;
	}

	const timestamp = asNonEmptyString(parsed.timestamp);
	if (timestamp == null) {
		return undefined;
	}

	const info = isRecord(payload.info) ? payload.info : undefined;
	const lastUsage = normalizeRawUsage(info?.last_token_usage);
	const totalUsage = normalizeRawUsage(info?.total_token_usage);
	const cumulativeTotalTokens = totalUsage?.total_tokens;

	let raw = lastUsage;
	if (raw == null && totalUsage != null) {
		raw = subtractRawUsage(totalUsage, state.previousTotals);
	}

	if (totalUsage != null) {
		state.previousTotals = totalUsage;
	}

	if (raw == null) {
		return {
			cumulativeTotalTokens,
		};
	}

	const delta = convertToDelta(raw);
	if (
		delta.inputTokens === 0 &&
		delta.cachedInputTokens === 0 &&
		delta.outputTokens === 0 &&
		delta.reasoningOutputTokens === 0
	) {
		return {
			cumulativeTotalTokens,
		};
	}

	const extractedModel = extractModel(payload, info);
	let isFallbackModel = false;
	if (extractedModel != null) {
		state.currentModel = extractedModel;
		state.currentModelIsFallback = false;
	}

	let model = extractedModel ?? state.currentModel;
	if (model == null) {
		model = LEGACY_FALLBACK_MODEL;
		isFallbackModel = true;
		state.legacyFallbackUsed = true;
		state.currentModel = model;
		state.currentModelIsFallback = true;
	} else if (extractedModel == null && state.currentModelIsFallback) {
		isFallbackModel = true;
	}

	const event: TokenUsageEvent = {
		sessionId,
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

	return {
		event,
		cumulativeTotalTokens,
	};
}

async function listSessionFiles(directoryPath: string): Promise<SessionFileCandidate[]> {
	const files = await glob(SESSION_GLOB, {
		cwd: directoryPath,
		absolute: true,
	});

	return files
		.map((file) => {
		const relativeSessionPath = path.relative(directoryPath, file);
		const normalizedSessionPath = relativeSessionPath.split(path.sep).join('/');
		return {
			file,
			relativeSessionPath: normalizedSessionPath,
			sessionId: normalizedSessionPath.replace(/\.jsonl$/i, ''),
		};
		})
		.sort((a, b) => a.relativeSessionPath.localeCompare(b.relativeSessionPath));
}

async function readSessionFileMetadata(
	candidate: SessionFileCandidate,
	fileStats: Stats,
	shouldCollectEvents: boolean,
): Promise<SessionFileEntry> {
	let metadataId = candidate.sessionId;
	let forkedFromId: string | undefined;

	const lines = createInterface({
		input: createReadStream(candidate.file, { encoding: 'utf8' }),
		crlfDelay: Infinity,
	});

	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === '') {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}

			if (!isRecord(parsed) || asNonEmptyString(parsed.type) !== 'session_meta') {
				continue;
			}

			const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
			const id = asNonEmptyString(payload?.id);
			if (id != null) {
				metadataId = id;
			}

			forkedFromId = asNonEmptyString(payload?.forked_from_id);
			break;
		}
	} catch (error) {
		logger.debug('Failed to read Codex session metadata', error);
	} finally {
		lines.close();
	}

	return {
		...candidate,
		fileStats,
		metadataId,
		forkedFromId,
		shouldCollectEvents,
	};
}

function collectRequiredSessionIds(
	entries: SessionFileEntry[],
	entriesByMetadataId: Map<string, SessionFileEntry>,
): Set<string> {
	const required = new Set<string>();

	for (const entry of entries) {
		if (!entry.shouldCollectEvents) {
			continue;
		}

		let current: SessionFileEntry | undefined = entry;
		while (current != null && !required.has(current.metadataId)) {
			required.add(current.metadataId);
			current =
				current.forkedFromId != null ? entriesByMetadataId.get(current.forkedFromId) : undefined;
		}
	}

	return required;
}

function orderSessionEntries(
	entries: SessionFileEntry[],
	requiredIds: Set<string>,
	entriesByMetadataId: Map<string, SessionFileEntry>,
): SessionFileEntry[] {
	const ordered: SessionFileEntry[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (entry: SessionFileEntry): void => {
		if (!requiredIds.has(entry.metadataId) || visited.has(entry.metadataId)) {
			return;
		}

		if (visiting.has(entry.metadataId)) {
			return;
		}

		visiting.add(entry.metadataId);
		if (entry.forkedFromId != null) {
			const parent = entriesByMetadataId.get(entry.forkedFromId);
			if (parent != null) {
				visit(parent);
			}
		}
		visiting.delete(entry.metadataId);
		visited.add(entry.metadataId);
		ordered.push(entry);
	};

	for (const entry of entries) {
		visit(entry);
	}

	return ordered;
}

export type LoadOptions = {
	sessionDirs?: string[];
	since?: string;
	until?: string;
	timezone?: string;
	onEvent?: (event: TokenUsageEvent) => void | Promise<void>;
	collectEvents?: boolean;
	sortEvents?: boolean;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
};

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const providedDirs =
		options.sessionDirs != null && options.sessionDirs.length > 0
			? options.sessionDirs.map((dir) => path.resolve(dir))
			: undefined;

	const codexHomeEnv = process.env[CODEX_HOME_ENV]?.trim();
	const codexHome =
		codexHomeEnv != null && codexHomeEnv !== '' ? path.resolve(codexHomeEnv) : DEFAULT_CODEX_DIR;
	const defaultSessionsDir = path.join(codexHome, DEFAULT_SESSION_SUBDIR);
	const sessionDirs = providedDirs ?? [defaultSessionsDir];

	const events: TokenUsageEvent[] = [];
	const missingDirectories: string[] = [];
	const collectEvents = options.collectEvents ?? options.onEvent == null;
	const sortEvents = collectEvents && (options.sortEvents ?? true);
	const rawTotalsByMetadataId = new Map<string, number[]>();

	for (const dir of sessionDirs) {
		const directoryPath = path.resolve(dir);

		let directoryStats: Stats;
		try {
			directoryStats = await stat(directoryPath);
		} catch {
			missingDirectories.push(directoryPath);
			continue;
		}

		if (!directoryStats.isDirectory()) {
			missingDirectories.push(directoryPath);
			continue;
		}

		const files = await listSessionFiles(directoryPath);
		const indexedFiles: SessionFileEntry[] = [];
		const entriesByMetadataId = new Map<string, SessionFileEntry>();
		for (const candidate of files) {
			let fileStats: Stats;
			try {
				fileStats = await stat(candidate.file);
			} catch (error) {
				logger.debug('Failed to stat Codex session file', error);
				continue;
			}

			const shouldCollectEvents = shouldReadSessionFile(
				candidate.relativeSessionPath,
				fileStats,
				options.since,
				options.until,
				options.timezone,
			);
			const entry = await readSessionFileMetadata(candidate, fileStats, shouldCollectEvents);
			indexedFiles.push(entry);
			if (!entriesByMetadataId.has(entry.metadataId)) {
				entriesByMetadataId.set(entry.metadataId, entry);
			}
		}

		const requiredIds = collectRequiredSessionIds(indexedFiles, entriesByMetadataId);
		const filesToParse = orderSessionEntries(indexedFiles, requiredIds, entriesByMetadataId);

		for (const entry of filesToParse) {
			const { file, sessionId, metadataId, forkedFromId, shouldCollectEvents } = entry;

			const state: SessionParseState = {
				previousTotals: null,
				currentModel: undefined,
				currentModelIsFallback: false,
				legacyFallbackUsed: false,
			};
			const ancestorTotals =
				forkedFromId != null ? rawTotalsByMetadataId.get(forkedFromId) : undefined;
			let replayPrefixDone = ancestorTotals == null || ancestorTotals.length === 0;
			let replayPrefixIndex = 0;
			const rawTotals: number[] = [];

			const lines = createInterface({
				input: createReadStream(file, { encoding: 'utf8' }),
				crlfDelay: Infinity,
			});

			try {
				for await (const line of lines) {
					const parsed = parseTokenUsageEvent(sessionId, line, state);
					if (parsed == null) {
						continue;
					}

					const cumulativeTotalTokens = parsed.cumulativeTotalTokens;
					if (cumulativeTotalTokens != null) {
						rawTotals.push(cumulativeTotalTokens);
					}

					const nextAncestorTotal =
						!replayPrefixDone && ancestorTotals != null
							? ancestorTotals[replayPrefixIndex]
							: undefined;
					if (
						nextAncestorTotal != null &&
						cumulativeTotalTokens != null &&
						cumulativeTotalTokens === nextAncestorTotal
					) {
						replayPrefixIndex += 1;
						continue;
					}
					replayPrefixDone = true;

					const event = parsed.event;
					if (event == null || !shouldCollectEvents) {
						continue;
					}

					if (
						!isEventWithinRange(event.timestamp, options.since, options.until, options.timezone)
					) {
						continue;
					}

					if (collectEvents) {
						events.push(event);
					}

					if (options.onEvent != null) {
						await options.onEvent(event);
					}
				}
			} catch (error) {
				logger.debug('Failed to stream Codex session file', error);
				continue;
			} finally {
				lines.close();
			}
			rawTotalsByMetadataId.set(metadataId, rawTotals);

			if (state.legacyFallbackUsed) {
				logger.debug('Legacy Codex session lacked model metadata; applied fallback', {
					file,
					model: LEGACY_FALLBACK_MODEL,
				});
			}
		}
	}

	if (sortEvents && events.length > 1) {
		events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
	}

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

		it('supports streaming callbacks without collecting events', async () => {
			await using fixture = await createFixture({
				sessions: {
					'streamed.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-15T13:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-15T13:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 10,
										cached_input_tokens: 0,
										output_tokens: 5,
										reasoning_output_tokens: 0,
										total_tokens: 15,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const seen: TokenUsageEvent[] = [];
			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
				collectEvents: false,
				sortEvents: false,
				onEvent: (event) => {
					seen.push(event);
				},
			});

			expect(events).toEqual([]);
			expect(seen).toHaveLength(1);
			expect(seen[0]!.totalTokens).toBe(15);
		});

		it('skips files that cannot overlap the requested date range', async () => {
			await using fixture = await createFixture({
				sessions: {
					'2025': {
						'09': {
							'10': {
								'old.jsonl': [
									JSON.stringify({
										timestamp: '2025-09-10T08:00:00.000Z',
										type: 'turn_context',
										payload: {
											model: 'gpt-5',
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-10T08:00:01.000Z',
										type: 'event_msg',
										payload: {
											type: 'token_count',
											info: {
												last_token_usage: {
													input_tokens: 1,
													cached_input_tokens: 0,
													output_tokens: 1,
													reasoning_output_tokens: 0,
													total_tokens: 2,
												},
											},
										},
									}),
								].join('\n'),
							},
							'12': {
								'new.jsonl': [
									JSON.stringify({
										timestamp: '2025-09-12T08:00:00.000Z',
										type: 'turn_context',
										payload: {
											model: 'gpt-5-mini',
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-12T08:00:01.000Z',
										type: 'event_msg',
										payload: {
											type: 'token_count',
											info: {
												last_token_usage: {
													input_tokens: 3,
													cached_input_tokens: 0,
													output_tokens: 2,
													reasoning_output_tokens: 0,
													total_tokens: 5,
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const oldPath = fixture.getPath('sessions/2025/09/10/old.jsonl');
			await utimes(
				oldPath,
				new Date('2025-09-10T08:00:01.000Z'),
				new Date('2025-09-10T08:00:01.000Z'),
			);

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
				since: '2025-09-12',
				until: '2025-09-12',
				timezone: 'UTC',
			});

			expect(events).toHaveLength(1);
			expect(events[0]!.sessionId).toBe('2025/09/12/new');
			expect(events[0]!.model).toBe('gpt-5-mini');
		});

		it('deduplicates replayed fork prefixes from child sessions', async () => {
			await using fixture = await createFixture({
				sessions: {
					'a-child.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-12T10:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'child-session',
								forked_from_id: 'parent-session',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T10:00:00.100Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T10:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 100,
									},
									last_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 100,
									},
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T10:00:02.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 150,
									},
									last_token_usage: {
										input_tokens: 40,
										cached_input_tokens: 0,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 50,
									},
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T10:00:03.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 144,
										cached_input_tokens: 0,
										output_tokens: 36,
										reasoning_output_tokens: 0,
										total_tokens: 180,
									},
									last_token_usage: {
										input_tokens: 24,
										cached_input_tokens: 0,
										output_tokens: 6,
										reasoning_output_tokens: 0,
										total_tokens: 30,
									},
								},
							},
						}),
					].join('\n'),
					'z-parent.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-12T09:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T09:00:00.100Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T09:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 100,
									},
									last_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 100,
									},
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T09:00:02.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 150,
									},
									last_token_usage: {
										input_tokens: 40,
										cached_input_tokens: 0,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 50,
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

			expect(events).toHaveLength(3);
			expect(events.map((event) => [event.sessionId, event.totalTokens])).toEqual([
				['z-parent', 100],
				['z-parent', 50],
				['a-child', 30],
			]);
		});

		it('loads fork ancestors outside the requested date range for deduplication', async () => {
			await using fixture = await createFixture({
				sessions: {
					'2025': {
						'09': {
							'10': {
								'parent.jsonl': [
									JSON.stringify({
										timestamp: '2025-09-10T09:00:00.000Z',
										type: 'session_meta',
										payload: {
											id: 'parent-range',
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-10T09:00:00.100Z',
										type: 'turn_context',
										payload: {
											model: 'gpt-5',
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-10T09:00:01.000Z',
										type: 'event_msg',
										payload: {
											type: 'token_count',
											info: {
												total_token_usage: {
													input_tokens: 80,
													cached_input_tokens: 0,
													output_tokens: 20,
													reasoning_output_tokens: 0,
													total_tokens: 100,
												},
												last_token_usage: {
													input_tokens: 80,
													cached_input_tokens: 0,
													output_tokens: 20,
													reasoning_output_tokens: 0,
													total_tokens: 100,
												},
											},
										},
									}),
								].join('\n'),
							},
							'12': {
								'child.jsonl': [
									JSON.stringify({
										timestamp: '2025-09-12T10:00:00.000Z',
										type: 'session_meta',
										payload: {
											id: 'child-range',
											forked_from_id: 'parent-range',
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-12T10:00:00.100Z',
										type: 'turn_context',
										payload: {
											model: 'gpt-5',
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-12T10:00:01.000Z',
										type: 'event_msg',
										payload: {
											type: 'token_count',
											info: {
												total_token_usage: {
													input_tokens: 80,
													cached_input_tokens: 0,
													output_tokens: 20,
													reasoning_output_tokens: 0,
													total_tokens: 100,
												},
												last_token_usage: {
													input_tokens: 80,
													cached_input_tokens: 0,
													output_tokens: 20,
													reasoning_output_tokens: 0,
													total_tokens: 100,
												},
											},
										},
									}),
									JSON.stringify({
										timestamp: '2025-09-12T10:00:02.000Z',
										type: 'event_msg',
										payload: {
											type: 'token_count',
											info: {
												total_token_usage: {
													input_tokens: 104,
													cached_input_tokens: 0,
													output_tokens: 26,
													reasoning_output_tokens: 0,
													total_tokens: 130,
												},
												last_token_usage: {
													input_tokens: 24,
													cached_input_tokens: 0,
													output_tokens: 6,
													reasoning_output_tokens: 0,
													total_tokens: 30,
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const parentPath = fixture.getPath('sessions/2025/09/10/parent.jsonl');
			await utimes(
				parentPath,
				new Date('2025-09-10T09:00:01.000Z'),
				new Date('2025-09-10T09:00:01.000Z'),
			);

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
				since: '2025-09-12',
				until: '2025-09-12',
				timezone: 'UTC',
			});

			expect(events).toHaveLength(1);
			expect(events[0]!.sessionId).toBe('2025/09/12/child');
			expect(events[0]!.totalTokens).toBe(30);
		});
	});
}
