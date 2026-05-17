import type {
	CodexWorkerData,
	CodexWorkerResponse,
	EncodedTokenUsageEvents,
	ParsedTokenCountLine,
	RawUsage,
	TokenUsageEvent,
} from './types.ts';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { processJSONLFileByMarkers } from '@ccusage/internal/jsonl';
import { compareStrings } from '@ccusage/internal/sort';
import {
	collectIndexedFileWorkerResults,
	getFileWorkerThreadCount,
} from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';
import { getCodexSessionsPath } from './paths.ts';

const LEGACY_FALLBACK_MODEL = 'gpt-5';
const CODEX_JSONL_MARKERS = ['turn_context', '"type":"token_count"', '"type": "token_count"'];
const ENCODED_CODEX_EVENT_NUMBER_STRIDE = 5;

export function parseTokenCountLineFast(_line: string): ParsedTokenCountLine | null {
	if (!hasTokenCountPayload(_line)) {
		return null;
	}

	const timestamp = findJSONStringValue(_line, 'timestamp');
	if (timestamp == null) {
		return null;
	}

	const infoText = findJSONObjectText(_line, 'info');
	if (infoText == null) {
		return null;
	}

	const lastUsageText = findJSONObjectText(infoText, 'last_token_usage');
	const totalUsageText = findJSONObjectText(infoText, 'total_token_usage');
	if (lastUsageText == null && totalUsageText == null) {
		return null;
	}

	return {
		timestamp,
		lastUsage: lastUsageText == null ? null : parseRawUsageText(lastUsageText),
		totalUsage: totalUsageText == null ? null : parseRawUsageText(totalUsageText),
		model:
			asNonEmptyString(findJSONStringValue(infoText, 'model')) ??
			asNonEmptyString(findJSONStringValue(infoText, 'model_name')),
	};
}

function ensureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function calculateFallbackTotalTokens(input: number, output: number, reasoning: number): number {
	return input + output + reasoning;
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
		total_tokens: total > 0 ? total : calculateFallbackTotalTokens(input, output, reasoning),
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

function convertToEventUsage(
	raw: RawUsage,
): Omit<TokenUsageEvent, 'timestamp' | 'sessionId' | 'model'> {
	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);
	return {
		inputTokens: raw.input_tokens,
		cachedInputTokens: cached,
		outputTokens: raw.output_tokens,
		reasoningOutputTokens: raw.reasoning_output_tokens,
		totalTokens:
			raw.total_tokens > 0
				? raw.total_tokens
				: calculateFallbackTotalTokens(
						raw.input_tokens,
						raw.output_tokens,
						raw.reasoning_output_tokens,
					),
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function extractModel(value: unknown): string | undefined {
	const payload = asRecord(value);
	if (payload == null) {
		return undefined;
	}

	const info = asRecord(payload.info);
	if (info != null) {
		const model = asNonEmptyString(info.model) ?? asNonEmptyString(info.model_name);
		if (model != null) {
			return model;
		}
		const metadata = asRecord(info.metadata);
		const metadataModel = asNonEmptyString(metadata?.model);
		if (metadataModel != null) {
			return metadataModel;
		}
	}

	const fallbackModel = asNonEmptyString(payload.model);
	if (fallbackModel != null) {
		return fallbackModel;
	}

	const metadata = asRecord(payload.metadata);
	return asNonEmptyString(metadata?.model);
}

function extractTurnContextModelFast(line: string): string | undefined {
	if (!line.includes('"type":"turn_context"') && !line.includes('"type": "turn_context"')) {
		return undefined;
	}
	const payloadText = findJSONObjectText(line, 'payload');
	if (payloadText == null) {
		return undefined;
	}
	return (
		asNonEmptyString(findJSONStringValue(payloadText, 'model')) ??
		asNonEmptyString(findJSONStringValue(payloadText, 'model_name'))
	);
}

async function parseCodexSessionFile(
	directoryPath: string,
	file: string,
): Promise<TokenUsageEvent[]> {
	const relativeSessionPath = path.relative(directoryPath, file);
	const normalizedSessionPath = relativeSessionPath.split(path.sep).join('/');
	const sessionId = normalizedSessionPath.replace(/\.jsonl$/i, '');
	const events: TokenUsageEvent[] = [];
	let previousTotals: RawUsage | null = null;
	let currentModel: string | undefined;
	let currentModelIsFallback = false;

	const addTokenCountEvent = (parsed: ParsedTokenCountLine): void => {
		let raw = parsed.lastUsage;
		if (raw == null && parsed.totalUsage != null) {
			raw = subtractRawUsage(parsed.totalUsage, previousTotals);
		}
		if (parsed.totalUsage != null) {
			previousTotals = parsed.totalUsage;
		}
		if (raw == null) {
			return;
		}

		const usage = convertToEventUsage(raw);
		if (
			usage.inputTokens === 0 &&
			usage.cachedInputTokens === 0 &&
			usage.outputTokens === 0 &&
			usage.reasoningOutputTokens === 0
		) {
			return;
		}

		let isFallbackModel = false;
		if (parsed.model != null) {
			currentModel = parsed.model;
			currentModelIsFallback = false;
		}

		let model = parsed.model ?? currentModel;
		if (model == null) {
			model = LEGACY_FALLBACK_MODEL;
			isFallbackModel = true;
			currentModel = model;
			currentModelIsFallback = true;
		} else if (parsed.model == null && currentModelIsFallback) {
			isFallbackModel = true;
		}

		events.push({
			sessionId,
			timestamp: parsed.timestamp,
			model,
			...usage,
			...(isFallbackModel ? { isFallbackModel: true } : {}),
		});
	};

	try {
		await processJSONLFileByMarkers(
			file,
			CODEX_JSONL_MARKERS,
			(line) => {
				const contextModel = extractTurnContextModelFast(line);
				if (contextModel != null) {
					currentModel = contextModel;
					currentModelIsFallback = false;
					return;
				}

				const parsedFast = parseTokenCountLineFast(line);
				if (parsedFast != null) {
					addTokenCountEvent(parsedFast);
					return;
				}

				try {
					const entry = asRecord(JSON.parse(line) as unknown);
					if (entry == null) {
						return;
					}
					const entryType = typeof entry.type === 'string' ? entry.type : undefined;
					const payload = entry.payload;
					const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
					if (entryType === 'turn_context') {
						const model = extractModel(payload);
						if (model != null) {
							currentModel = model;
							currentModelIsFallback = false;
						}
						return;
					}
					if (entryType !== 'event_msg' || timestamp == null) {
						return;
					}
					const payloadRecord = asRecord(payload);
					if (payloadRecord?.type !== 'token_count') {
						return;
					}
					const info = asRecord(payloadRecord.info);
					addTokenCountEvent({
						timestamp,
						lastUsage: normalizeRawUsage(info?.last_token_usage),
						totalUsage: normalizeRawUsage(info?.total_token_usage),
						model: extractModel({ info, ...payloadRecord }),
					});
				} catch {}
			},
			{
				bufferedEncoding: 'latin1',
				callbackMode: 'sync',
				scanMode: 'line',
			},
		);
	} catch (error) {
		logger.debug('Failed to read Codex session file', error);
	}

	return events;
}

function getCodexWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function collectCodexEventsWithWorkers(
	directoryPath: string,
	files: string[],
): Promise<TokenUsageEvent[] | null> {
	const workerCount = getCodexWorkerThreadCount(files.length);
	const fileEvents = await collectIndexedFileWorkerResults<
		string,
		EncodedTokenUsageEvents,
		CodexWorkerData
	>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'ccusage codex worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:codex-worker',
				directoryPath,
				items,
			}) satisfies CodexWorkerData,
	});
	return fileEvents?.flatMap(decodeTokenUsageEvents) ?? null;
}

function encodeTokenUsageEvents(events: TokenUsageEvent[]): EncodedTokenUsageEvents {
	const timestamps: string[] = [];
	const sessionIds: string[] = [];
	const models: string[] = [];
	const modelIndexes = new Int32Array(events.length);
	const numbers = new Float64Array(events.length * ENCODED_CODEX_EVENT_NUMBER_STRIDE);
	const flags = new Uint8Array(events.length);
	const modelIndexByName = new Map<string, number>();

	for (let index = 0; index < events.length; index++) {
		const event = events[index]!;
		timestamps.push(event.timestamp);
		sessionIds.push(event.sessionId);
		if (event.model == null) {
			modelIndexes[index] = -1;
		} else {
			let modelIndex = modelIndexByName.get(event.model);
			if (modelIndex == null) {
				modelIndex = models.length;
				modelIndexByName.set(event.model, modelIndex);
				models.push(event.model);
			}
			modelIndexes[index] = modelIndex;
		}

		const numberOffset = index * ENCODED_CODEX_EVENT_NUMBER_STRIDE;
		numbers[numberOffset] = event.inputTokens;
		numbers[numberOffset + 1] = event.cachedInputTokens;
		numbers[numberOffset + 2] = event.outputTokens;
		numbers[numberOffset + 3] = event.reasoningOutputTokens;
		numbers[numberOffset + 4] = event.totalTokens;
		flags[index] = event.isFallbackModel === true ? 1 : 0;
	}

	return { timestamps, sessionIds, models, modelIndexes, numbers, flags };
}

function decodeTokenUsageEvents(encoded: EncodedTokenUsageEvents): TokenUsageEvent[] {
	const events: TokenUsageEvent[] = [];
	for (let index = 0; index < encoded.timestamps.length; index++) {
		const numberOffset = index * ENCODED_CODEX_EVENT_NUMBER_STRIDE;
		const modelIndex = encoded.modelIndexes[index] ?? -1;
		events.push({
			timestamp: encoded.timestamps[index]!,
			sessionId: encoded.sessionIds[index]!,
			...(modelIndex >= 0 ? { model: encoded.models[modelIndex] } : {}),
			inputTokens: encoded.numbers[numberOffset] ?? 0,
			cachedInputTokens: encoded.numbers[numberOffset + 1] ?? 0,
			outputTokens: encoded.numbers[numberOffset + 2] ?? 0,
			reasoningOutputTokens: encoded.numbers[numberOffset + 3] ?? 0,
			totalTokens: encoded.numbers[numberOffset + 4] ?? 0,
			...(encoded.flags[index] === 1 ? { isFallbackModel: true } : {}),
		});
	}
	return events;
}

export async function loadTokenUsageEvents(): Promise<TokenUsageEvent[]> {
	const directoryPath = getCodexSessionsPath();
	const statResult = await Result.try({
		try: stat(directoryPath),
		catch: (error) => error,
	});
	if (Result.isFailure(statResult) || !statResult.value.isDirectory()) {
		return [];
	}

	const files = await collectFilesRecursive(directoryPath, { extension: '.jsonl' });
	const workerEvents = await collectCodexEventsWithWorkers(directoryPath, files);
	if (workerEvents != null) {
		return workerEvents.sort((a, b) => compareStrings(a.timestamp, b.timestamp));
	}

	const fileEvents = await Promise.all(
		files.map(async (file) => parseCodexSessionFile(directoryPath, file)),
	);
	return fileEvents.flat().sort((a, b) => compareStrings(a.timestamp, b.timestamp));
}

async function runCodexWorker(data: CodexWorkerData): Promise<void> {
	const results = [];
	const transferList: ArrayBuffer[] = [];
	for (const { index, item } of data.items) {
		const result = encodeTokenUsageEvents(await parseCodexSessionFile(data.directoryPath, item));
		transferList.push(
			result.modelIndexes.buffer as ArrayBuffer,
			result.numbers.buffer as ArrayBuffer,
			result.flags.buffer as ArrayBuffer,
		);
		results.push({
			index,
			result,
		});
	}
	parentPort!.postMessage({ results } satisfies CodexWorkerResponse, transferList);
}

if (!isMainThread && asRecord(workerData)?.kind === 'ccusage:codex-worker') {
	void runCodexWorker(workerData as CodexWorkerData).catch(() => {
		process.exit(1);
	});
}

function hasTokenCountPayload(line: string): boolean {
	if (!line.includes('"type":"event_msg"') && !line.includes('"type": "event_msg"')) {
		return false;
	}
	return line.includes('"type":"token_count"') || line.includes('"type": "token_count"');
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function findJSONStringValue(value: string, key: string): string | undefined {
	const marker = `"${key}":`;
	const markerIndex = value.indexOf(marker);
	if (markerIndex === -1) {
		return undefined;
	}

	let index = markerIndex + marker.length;
	while (value.charCodeAt(index) === 32 || value.charCodeAt(index) === 9) {
		index++;
	}
	if (value.charCodeAt(index) !== 34) {
		return undefined;
	}

	const start = index + 1;
	index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === 92) {
			return undefined;
		}
		if (code === 34) {
			return value.slice(start, index);
		}
		index++;
	}
	return undefined;
}

function findJSONObjectText(value: string, key: string): string | undefined {
	const marker = `"${key}":`;
	const markerIndex = value.indexOf(marker);
	if (markerIndex === -1) {
		return undefined;
	}

	let index = markerIndex + marker.length;
	while (value.charCodeAt(index) === 32 || value.charCodeAt(index) === 9) {
		index++;
	}
	if (value.charCodeAt(index) !== 123) {
		return undefined;
	}

	const start = index;
	let depth = 0;
	let inString = false;
	let escaped = false;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (code === 92) {
				escaped = true;
			} else if (code === 34) {
				inString = false;
			}
			index++;
			continue;
		}
		if (code === 34) {
			inString = true;
		} else if (code === 123) {
			depth++;
		} else if (code === 125) {
			depth--;
			if (depth === 0) {
				return value.slice(start, index + 1);
			}
		}
		index++;
	}

	return undefined;
}

function findJSONNumberValue(value: string, key: string): number | undefined {
	const marker = `"${key}":`;
	const markerIndex = value.indexOf(marker);
	if (markerIndex === -1) {
		return undefined;
	}

	let index = markerIndex + marker.length;
	while (value.charCodeAt(index) === 32 || value.charCodeAt(index) === 9) {
		index++;
	}
	const start = index;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code < 48 || code > 57) {
			break;
		}
		index++;
	}
	if (index === start) {
		return undefined;
	}

	const parsed = Number(value.slice(start, index));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRawUsageText(value: string): RawUsage {
	const input = findJSONNumberValue(value, 'input_tokens') ?? 0;
	const cached =
		findJSONNumberValue(value, 'cached_input_tokens') ??
		findJSONNumberValue(value, 'cache_read_input_tokens') ??
		0;
	const output = findJSONNumberValue(value, 'output_tokens') ?? 0;
	const reasoning = findJSONNumberValue(value, 'reasoning_output_tokens') ?? 0;
	const total = findJSONNumberValue(value, 'total_tokens') ?? 0;
	return {
		input_tokens: input,
		cached_input_tokens: cached,
		output_tokens: output,
		reasoning_output_tokens: reasoning,
		total_tokens: total > 0 ? total : calculateFallbackTotalTokens(input, output, reasoning),
	};
}

if (import.meta.vitest != null) {
	describe('Codex worker event encoding', () => {
		it('round-trips token usage events without losing fallback model metadata', () => {
			const events: TokenUsageEvent[] = [
				{
					timestamp: '2026-05-14T00:00:00.000Z',
					sessionId: 'project/session-a',
					model: 'gpt-5.4',
					inputTokens: 100,
					cachedInputTokens: 20,
					outputTokens: 30,
					reasoningOutputTokens: 40,
					totalTokens: 170,
				},
				{
					timestamp: '2026-05-14T00:00:01.000Z',
					sessionId: 'project/session-a',
					model: 'gpt-5',
					isFallbackModel: true,
					inputTokens: 10,
					cachedInputTokens: 0,
					outputTokens: 5,
					reasoningOutputTokens: 0,
					totalTokens: 15,
				},
			];

			expect(decodeTokenUsageEvents(encodeTokenUsageEvents(events))).toEqual(events);
		});
	});

	describe('Codex adapter JSONL fast parser', () => {
		it('parses token_count usage without parsing surrounding turn context history', () => {
			const line = JSON.stringify({
				timestamp: '2026-02-15T02:27:08.541Z',
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {
							input_tokens: 12_127,
							cached_input_tokens: 6_912,
							output_tokens: 623,
							reasoning_output_tokens: 454,
							total_tokens: 12_750,
						},
						last_token_usage: {
							input_tokens: 12_127,
							cached_input_tokens: 6_912,
							output_tokens: 623,
							reasoning_output_tokens: 454,
							total_tokens: 12_750,
						},
						model: 'gpt-5.2-codex',
					},
				},
			});

			expect(parseTokenCountLineFast(line)).toEqual({
				timestamp: '2026-02-15T02:27:08.541Z',
				lastUsage: {
					input_tokens: 12_127,
					cached_input_tokens: 6_912,
					output_tokens: 623,
					reasoning_output_tokens: 454,
					total_tokens: 12_750,
				},
				totalUsage: {
					input_tokens: 12_127,
					cached_input_tokens: 6_912,
					output_tokens: 623,
					reasoning_output_tokens: 454,
					total_tokens: 12_750,
				},
				model: 'gpt-5.2-codex',
			});
		});

		it('includes reasoning tokens when token_count omits total tokens', () => {
			const line = JSON.stringify({
				timestamp: '2026-02-15T02:27:08.541Z',
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						last_token_usage: {
							input_tokens: 12_127,
							cached_input_tokens: 6_912,
							output_tokens: 623,
							reasoning_output_tokens: 454,
						},
						model: 'gpt-5.2-codex',
					},
				},
			});

			expect(parseTokenCountLineFast(line)?.lastUsage?.total_tokens).toBe(13_204);
		});

		it('does not treat token_count text inside turn_context history as a usage event', () => {
			const line = JSON.stringify({
				timestamp: '2026-02-15T02:27:07.541Z',
				type: 'turn_context',
				payload: {
					model: 'gpt-5.2-codex',
					history: [{ type: 'token_count' }],
				},
			});

			expect(parseTokenCountLineFast(line)).toBeNull();
		});
	});

	describe('getCodexWorkerThreadCount', () => {
		it('uses Claude-style bundled worker gating', () => {
			expect(getCodexWorkerThreadCount(100)).toBe(0);
		});
	});
}
