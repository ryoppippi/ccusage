import type { IndexedWorkerItem } from '@ccusage/internal/workers';
import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import type {
	CodexGroup,
	CodexModelUsage,
	CodexReportRow,
	CodexWorkerData,
	CodexWorkerResponse,
	ParsedTokenCountLine,
	RawUsage,
	TokenUsageEvent,
} from './types.ts';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { collectFilesRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { processJSONLFileByLine } from '@ccusage/internal/jsonl';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { chunkIndexedItemsByFileSize, getFileWorkerThreadCount } from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import {
	createEmptyRow,
	formatDateKey,
	formatMonthKey,
	isWithinRange,
	normalizeDateFilter,
} from '../shared.ts';
import { getCodexSessionsPath } from './paths.ts';
import { prefetchCodexPricing } from './pricing-macro.ts' with { type: 'macro' };
import {
	calculateCodexCostUSD,
	CODEX_PROVIDER_PREFIXES,
	getCodexPricing,
	resolveCodexSpeed,
} from './pricing.ts';
import { addCodexUsage, createCodexUsage } from './usage.ts';

const LEGACY_FALLBACK_MODEL = 'gpt-5';

export { detectCodex } from './paths.ts';
export type { CodexModelUsage, CodexReportRow } from './types.ts';

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

function convertToEventUsage(
	raw: RawUsage,
): Omit<TokenUsageEvent, 'timestamp' | 'sessionId' | 'model'> {
	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);
	return {
		inputTokens: raw.input_tokens,
		cachedInputTokens: cached,
		outputTokens: raw.output_tokens,
		reasoningOutputTokens: raw.reasoning_output_tokens,
		totalTokens: raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens,
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
		await processJSONLFileByLine(file, (line) => {
			if (!line.includes('turn_context') && !line.includes('token_count')) {
				return;
			}

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
		});
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
	if (workerCount === 0) {
		return null;
	}

	const indexedFiles = files.map<IndexedWorkerItem<string>>((file, index) => ({
		index,
		item: file,
	}));
	const chunks = await chunkIndexedItemsByFileSize(indexedFiles, workerCount, (file) => file);
	const workerResults = chunks.map(
		async (chunk) =>
			new Promise<Array<{ index: number; result: TokenUsageEvent[] }>>((resolve, reject) => {
				const worker = new Worker(new URL(import.meta.url), {
					workerData: {
						kind: 'ccusage:codex-worker',
						directoryPath,
						items: chunk,
					} satisfies CodexWorkerData,
				});
				worker.once('message', (message: CodexWorkerResponse) => {
					resolve(message.results);
				});
				worker.once('error', reject);
				worker.once('exit', (code) => {
					if (code !== 0) {
						reject(new Error(`ccusage codex worker exited with code ${code}`));
					}
				});
			}),
	);
	const resultGroups = await Promise.all(workerResults);
	const fileEvents = Array.from<TokenUsageEvent[] | undefined>({ length: files.length });
	for (const results of resultGroups) {
		for (const { index, result } of results) {
			fileEvents[index] = result;
		}
	}

	return fileEvents.flatMap((events) => events ?? []);
}

async function loadTokenUsageEvents(): Promise<TokenUsageEvent[]> {
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
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await parseCodexSessionFile(data.directoryPath, item),
		});
	}
	parentPort!.postMessage({ results } satisfies CodexWorkerResponse);
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
		total_tokens: total > 0 ? total : input + output,
	};
}

export async function loadCodexRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const speed = await resolveCodexSpeed(options.speed);
	const events = await loadTokenUsageEvents();
	const ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({
					offline: options.offline === true,
					offlineLoader: async () => prefetchCodexPricing(),
					logger,
					providerPrefixes: CODEX_PROVIDER_PREFIXES,
				})
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher!;
	try {
		const groups = new Map<string, CodexGroup>();
		for (const event of events) {
			const modelName = event.model?.trim();
			if (modelName == null || modelName === '') {
				continue;
			}
			const date = formatDateKey(event.timestamp, options.timezone);
			if (!isWithinRange(date, since, until)) {
				continue;
			}
			const period =
				kind === 'session'
					? event.sessionId
					: kind === 'monthly'
						? formatMonthKey(event.timestamp, options.timezone)
						: date;
			const group = groups.get(period) ?? {
				row: createEmptyRow(period, 'codex'),
				models: new Map<string, CodexModelUsage>(),
				reasoningOutputTokens: 0,
				lastActivity: event.timestamp,
			};
			if (!groups.has(period)) {
				groups.set(period, group);
			}

			group.row.inputTokens += event.inputTokens;
			group.row.outputTokens += event.outputTokens;
			group.row.cacheReadTokens += event.cachedInputTokens;
			group.row.totalTokens += event.totalTokens;
			group.reasoningOutputTokens += event.reasoningOutputTokens;
			if (event.timestamp > group.lastActivity) {
				group.lastActivity = event.timestamp;
			}

			const modelUsage = group.models.get(modelName) ?? createCodexUsage();
			if (!group.models.has(modelName)) {
				group.models.set(modelName, modelUsage);
			}
			addCodexUsage(modelUsage, event);
		}

		const pricingByModel = new Map<string, Awaited<ReturnType<typeof getCodexPricing>>>();
		for (const group of groups.values()) {
			for (const model of group.models.keys()) {
				if (!pricingByModel.has(model)) {
					pricingByModel.set(model, await getCodexPricing(model, fetcher, speed));
				}
			}
		}

		return Array.from(groups.values(), ({ row, models, reasoningOutputTokens, lastActivity }) => {
			let totalCost = 0;
			for (const [model, usage] of models) {
				const pricing = pricingByModel.get(model);
				if (pricing != null) {
					totalCost += calculateCodexCostUSD(usage, pricing);
				}
			}
			return {
				...row,
				totalCost,
				modelsUsed: Array.from(models.keys()).sort(compareStrings),
				metadata: { lastActivity, reasoningOutputTokens },
			};
		}).sort((a, b) => compareStrings(a.period, b.period));
	} finally {
		ownedFetcher?.[Symbol.dispose]();
	}
}

export async function loadCodexReportRows(
	kind: Extract<ReportKind, 'daily' | 'monthly' | 'session'>,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<CodexReportRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const speed = await resolveCodexSpeed(options.speed);
	const events = await loadTokenUsageEvents();
	const ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({
					offline: options.offline === true,
					offlineLoader: async () => prefetchCodexPricing(),
					logger,
					providerPrefixes: CODEX_PROVIDER_PREFIXES,
				})
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher!;
	try {
		const groups = new Map<
			string,
			{
				inputTokens: number;
				cachedInputTokens: number;
				outputTokens: number;
				reasoningOutputTokens: number;
				totalTokens: number;
				lastActivity: string;
				models: Map<string, CodexModelUsage>;
			}
		>();
		for (const event of events) {
			const modelName = event.model?.trim();
			if (modelName == null || modelName === '') {
				continue;
			}
			const date = formatDateKey(event.timestamp, options.timezone);
			if (!isWithinRange(date, since, until)) {
				continue;
			}
			const period =
				kind === 'session'
					? event.sessionId
					: kind === 'monthly'
						? formatMonthKey(event.timestamp, options.timezone)
						: date;
			const group = groups.get(period) ?? {
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
				lastActivity: event.timestamp,
				models: new Map<string, CodexModelUsage>(),
			};
			if (!groups.has(period)) {
				groups.set(period, group);
			}

			group.inputTokens += event.inputTokens;
			group.cachedInputTokens += event.cachedInputTokens;
			group.outputTokens += event.outputTokens;
			group.reasoningOutputTokens += event.reasoningOutputTokens;
			group.totalTokens += event.totalTokens;
			if (event.timestamp > group.lastActivity) {
				group.lastActivity = event.timestamp;
			}

			const modelUsage = group.models.get(modelName) ?? createCodexUsage();
			if (!group.models.has(modelName)) {
				group.models.set(modelName, modelUsage);
			}
			addCodexUsage(modelUsage, event);
			if (event.isFallbackModel === true) {
				modelUsage.isFallback = true;
			}
		}

		const pricingByModel = new Map<string, Awaited<ReturnType<typeof getCodexPricing>>>();
		for (const group of groups.values()) {
			for (const model of group.models.keys()) {
				if (!pricingByModel.has(model)) {
					pricingByModel.set(model, await getCodexPricing(model, fetcher, speed));
				}
			}
		}

		return Array.from(groups.entries(), ([period, group]) => {
			let costUSD = 0;
			const models: Record<string, CodexModelUsage> = {};
			for (const [model, usage] of group.models) {
				const pricing = pricingByModel.get(model);
				if (pricing != null) {
					costUSD += calculateCodexCostUSD(usage, pricing);
				}
				models[model] = { ...usage };
			}
			const base = {
				inputTokens: group.inputTokens,
				cachedInputTokens: group.cachedInputTokens,
				outputTokens: group.outputTokens,
				reasoningOutputTokens: group.reasoningOutputTokens,
				totalTokens: group.totalTokens,
				costUSD,
				models,
			};
			if (kind === 'daily') {
				return { date: period, ...base };
			}
			if (kind === 'monthly') {
				return { month: period, ...base };
			}
			const separatorIndex = period.lastIndexOf('/');
			return {
				sessionId: period,
				lastActivity: group.lastActivity,
				sessionFile: separatorIndex >= 0 ? period.slice(separatorIndex + 1) : period,
				directory: separatorIndex >= 0 ? period.slice(0, separatorIndex) : '',
				...base,
			};
		}).sort((a, b) => {
			const aKey = 'date' in a ? a.date : 'month' in a ? a.month : a.lastActivity;
			const bKey = 'date' in b ? b.date : 'month' in b ? b.month : b.lastActivity;
			return compareStrings(aKey, bKey);
		});
	} finally {
		ownedFetcher?.[Symbol.dispose]();
	}
}

if (import.meta.vitest != null) {
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

	describe('loadCodexRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads and aggregates Codex JSONL usage inside ccusage adapter', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2026-01-01T00:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2026-01-01T00:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 20,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 110,
									},
									total_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 20,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 110,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			vi.stubEnv('CODEX_HOME', fixture.path);
			const rows = await loadCodexRows(
				'daily',
				{ offline: true, timezone: 'UTC' },
				{
					pricingFetcher: new LiteLLMPricingFetcher({
						offline: true,
						offlineLoader: async () => ({
							'gpt-5': {
								input_cost_per_token: 1e-6,
								output_cost_per_token: 2e-6,
								cache_read_input_token_cost: 1e-7,
							},
						}),
					}),
				},
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				period: '2026-01-01',
				agent: 'codex',
				modelsUsed: ['gpt-5'],
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 20,
				totalTokens: 110,
			});
			expect(rows[0]!.totalCost).toBeCloseTo(0.000084);
		});

		it('uses the Codex log total token field for all-agent rows so direct and all reports stay consistent when reasoning tokens are present', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2026-01-01T00:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2026-01-01T00:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 20,
										output_tokens: 10,
										reasoning_output_tokens: 70,
										total_tokens: 180,
									},
								},
							},
						}),
					].join('\n'),
				},
			});
			vi.stubEnv('CODEX_HOME', fixture.path);
			const pricingFetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
						cache_read_input_token_cost: 1e-7,
					},
				}),
			});

			const [allRows, reportRows] = await Promise.all([
				loadCodexRows('daily', { offline: true, timezone: 'UTC' }, { pricingFetcher }),
				loadCodexReportRows('daily', { offline: true, timezone: 'UTC' }, { pricingFetcher }),
			]);

			expect(allRows[0]?.totalTokens).toBe(180);
			expect(reportRows[0]?.totalTokens).toBe(180);
		});

		it('keeps Codex-specific JSON report totals on the fast adapter path', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2026-01-02T00:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2026-01-02T00:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 30,
										output_tokens: 11,
										reasoning_output_tokens: 3,
										total_tokens: 131,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			vi.stubEnv('CODEX_HOME', fixture.path);
			const rows = await loadCodexReportRows(
				'daily',
				{ offline: true, timezone: 'UTC' },
				{
					pricingFetcher: new LiteLLMPricingFetcher({
						offline: true,
						offlineLoader: async () => ({
							'gpt-5': {
								input_cost_per_token: 1e-6,
								output_cost_per_token: 2e-6,
								cache_read_input_token_cost: 1e-7,
							},
						}),
					}),
				},
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toEqual({
				date: '2026-01-02',
				inputTokens: 120,
				cachedInputTokens: 30,
				outputTokens: 11,
				reasoningOutputTokens: 3,
				totalTokens: 131,
				costUSD: rows[0]!.costUSD,
				models: {
					'gpt-5': {
						inputTokens: 120,
						cachedInputTokens: 30,
						outputTokens: 11,
						reasoningOutputTokens: 3,
						totalTokens: 131,
						isFallback: false,
					},
				},
			});
			expect(rows[0]!.costUSD).toBeCloseTo(0.000115);
		});

		it.skipIf(!isDirectorySyncSafe(getCodexSessionsPath()))(
			'loads local Codex usage rows when the user has a sessions directory',
			async () => {
				const rows = await loadCodexRows('daily', { offline: true, timezone: 'UTC' }, {});

				expect(rows.length).toBeGreaterThan(0);
			},
		);
	});

	describe('getCodexWorkerThreadCount', () => {
		it('uses Claude-style bundled worker gating', () => {
			expect(getCodexWorkerThreadCount(100)).toBe(0);
		});
	});
}
