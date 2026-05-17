import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import { stat } from 'node:fs/promises';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { processJSONLFileByMarkers } from '@ccusage/internal/jsonl';
import { compareStrings } from '@ccusage/internal/sort';
import {
	collectIndexedFileWorkerResults,
	getDefaultWorkerThreadCount,
	getFileWorkerThreadCount,
	mapWithConcurrency,
} from '@ccusage/internal/workers';
import { createFixture } from 'fs-fixture';
import { discoverCopilotOtelFiles } from './paths.ts';

export type CopilotUsageEntry = {
	timestamp: string;
	sessionId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	dedupKey: string;
};

type CopilotWorkerData = IndexedWorkerData<'ccusage:copilot-worker', string>;

type CopilotWorkerResponse = IndexedWorkerResultsMessage<CopilotUsageEntry[]>;

type CopilotUsageSource = 'chat-span' | 'inference-log' | 'agent-turn-log' | 'agent-summary-span';

type TraceContext = {
	model?: string;
	sessionId?: string;
	sessionIdPriority: number;
};

type CopilotUsageCandidate = {
	source: CopilotUsageSource;
	traceId?: string;
	responseId?: string;
	model: string;
	sessionId: string;
	timestampMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningOutputTokens: number;
	dedupKey: string;
};

const COPILOT_JSONL_MARKERS = ['"attributes"'];
const MODEL_ATTRS = ['gen_ai.response.model', 'gen_ai.request.model'] as const;
const SESSION_ATTRS = [
	['gen_ai.conversation.id', 3],
	['copilot_chat.session_id', 3],
	['copilot_chat.chat_session_id', 3],
	['session.id', 3],
	['github.copilot.interaction_id', 2],
	['gen_ai.response.id', 1],
] as const satisfies readonly (readonly [string, number])[];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function attrString(attributes: Record<string, unknown>, key: string): string | undefined {
	return stringValue(attributes[key]);
}

function attrNumber(attributes: Record<string, unknown>, key: string): number {
	return Math.max(numberValue(attributes[key]) ?? 0, 0);
}

function attrNumberFirst(attributes: Record<string, unknown>, keys: readonly string[]): number {
	for (const key of keys) {
		const value = attrNumber(attributes, key);
		if (value > 0) {
			return value;
		}
	}
	return 0;
}

function firstNonEmptyAttr(
	attributes: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = attrString(attributes, key);
		if (value != null) {
			return value;
		}
	}
	return undefined;
}

function bestSessionAttr(attributes: Record<string, unknown>): [string, number] | undefined {
	let best: [string, number] | undefined;
	for (const [key, priority] of SESSION_ATTRS) {
		const value = attrString(attributes, key);
		if (value == null) {
			continue;
		}
		if (best == null || priority > best[1]) {
			best = [value, priority];
		}
	}
	return best;
}

function traceIdFromRecord(record: Record<string, unknown>): string | undefined {
	const direct = stringValue(record.traceId);
	if (direct != null) {
		return direct;
	}
	return stringValue(asRecord(record.spanContext)?.traceId);
}

function spanIdFromRecord(record: Record<string, unknown>): string | undefined {
	const direct = stringValue(record.spanId);
	if (direct != null) {
		return direct;
	}
	return stringValue(asRecord(record.spanContext)?.spanId);
}

function recordBody(record: Record<string, unknown>): string | undefined {
	return stringValue(record.body) ?? stringValue(record._body);
}

function isSpanRecord(record: Record<string, unknown>): boolean {
	const type = stringValue(record.type);
	if (type != null) {
		return type === 'span';
	}
	return (
		stringValue(record.name) != null &&
		(stringValue(record.spanId) != null ||
			stringValue(record.traceId) != null ||
			record.startTime != null ||
			record.endTime != null ||
			record.duration != null ||
			record.kind != null)
	);
}

function isChatSpanRecord(
	record: Record<string, unknown>,
	attributes: Record<string, unknown>,
): boolean {
	return (
		isSpanRecord(record) &&
		(attrString(attributes, 'gen_ai.operation.name') === 'chat' ||
			stringValue(record.name)?.startsWith('chat ') === true)
	);
}

function isAgentSummarySpanRecord(
	record: Record<string, unknown>,
	attributes: Record<string, unknown>,
): boolean {
	return (
		isSpanRecord(record) &&
		(attrString(attributes, 'gen_ai.operation.name') === 'invoke_agent' ||
			stringValue(record.name)?.startsWith('invoke_agent ') === true)
	);
}

function isInferenceLogRecord(
	record: Record<string, unknown>,
	attributes: Record<string, unknown>,
): boolean {
	return (
		!isSpanRecord(record) &&
		(attrString(attributes, 'event.name') === 'gen_ai.client.inference.operation.details' ||
			recordBody(record)?.startsWith('GenAI inference:') === true)
	);
}

function isAgentTurnLogRecord(
	record: Record<string, unknown>,
	attributes: Record<string, unknown>,
): boolean {
	return (
		!isSpanRecord(record) &&
		(attrString(attributes, 'event.name') === 'copilot_chat.agent.turn' ||
			recordBody(record)?.startsWith('copilot_chat.agent.turn') === true)
	);
}

function timestampMsFromParts(value: unknown): number | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const seconds = numberValue(value[0]);
	const nanos = numberValue(value[1]);
	if (seconds == null || nanos == null) {
		return undefined;
	}
	return seconds * 1000 + Math.trunc(nanos / 1_000_000);
}

function timestampMsFromScalar(value: unknown): number | undefined {
	const raw = numberValue(value);
	if (raw == null) {
		return undefined;
	}
	const abs = Math.abs(raw);
	if (abs >= 100_000_000_000_000_000) {
		return Math.trunc(raw / 1_000_000);
	}
	if (abs >= 100_000_000_000_000) {
		return Math.trunc(raw / 1_000);
	}
	if (abs >= 100_000_000_000) {
		return raw;
	}
	return raw * 1000;
}

function timestampMsFromUnixNanos(value: unknown): number | undefined {
	const raw = numberValue(value);
	return raw == null || raw <= 0 ? undefined : Math.trunc(raw / 1_000_000);
}

function timestampMsFromRecord(record: Record<string, unknown>): number | undefined {
	return (
		timestampMsFromParts(record.endTime) ??
		timestampMsFromParts(record.startTime) ??
		timestampMsFromParts(record.hrTime) ??
		timestampMsFromParts(record._hrTime) ??
		timestampMsFromParts(record.time) ??
		timestampMsFromScalar(record.timestamp) ??
		timestampMsFromScalar(record.observedTimestamp) ??
		timestampMsFromUnixNanos(record.timeUnixNano)
	);
}

function dedupKeyForRecord(
	source: CopilotUsageSource,
	record: Record<string, unknown>,
	attributes: Record<string, unknown>,
	traceId: string | undefined,
	sessionId: string,
	timestampMs: number,
	index: number,
): string {
	const spanId = spanIdFromRecord(record);
	if (source === 'chat-span' || source === 'agent-summary-span') {
		return traceId != null && spanId != null
			? `${traceId}:${spanId}`
			: `span:${sessionId}:${timestampMs}:${index}`;
	}
	if (source === 'inference-log') {
		return traceId != null && spanId != null
			? `log:${traceId}:${spanId}`
			: `log:${sessionId}:${timestampMs}:${index}`;
	}
	const turnIndex =
		numberValue(attributes['turn.index']) ??
		numberValue(attributes['copilot_chat.turn.index']) ??
		`idx-${index}`;
	return traceId == null
		? `agent-turn:${sessionId}:${turnIndex}:${index}`
		: `agent-turn:${traceId}:${turnIndex}`;
}

async function fileModifiedTimestampMs(filePath: string): Promise<number> {
	try {
		return (await stat(filePath)).mtimeMs;
	} catch {
		return Date.now();
	}
}

function collectTraceContexts(
	records: readonly Record<string, unknown>[],
): Map<string, TraceContext> {
	const contexts = new Map<string, TraceContext>();
	for (const record of records) {
		const traceId = traceIdFromRecord(record);
		const attributes = asRecord(record.attributes);
		if (traceId == null || attributes == null) {
			continue;
		}
		const context = contexts.get(traceId) ?? { sessionIdPriority: 0 };
		context.model ??= firstNonEmptyAttr(attributes, MODEL_ATTRS);
		const session = bestSessionAttr(attributes);
		if (session != null && session[1] > context.sessionIdPriority) {
			context.sessionId = session[0];
			context.sessionIdPriority = session[1];
		}
		contexts.set(traceId, context);
	}
	return contexts;
}

function toCandidate(
	record: Record<string, unknown>,
	index: number,
	fallbackTimestampMs: number,
	traceContexts: ReadonlyMap<string, TraceContext>,
): CopilotUsageCandidate | undefined {
	const attributes = asRecord(record.attributes);
	if (attributes == null) {
		return undefined;
	}
	const source: CopilotUsageSource | undefined = isChatSpanRecord(record, attributes)
		? 'chat-span'
		: isInferenceLogRecord(record, attributes)
			? 'inference-log'
			: isAgentTurnLogRecord(record, attributes)
				? 'agent-turn-log'
				: isAgentSummarySpanRecord(record, attributes)
					? 'agent-summary-span'
					: undefined;
	if (source == null) {
		return undefined;
	}

	const input = attrNumber(attributes, 'gen_ai.usage.input_tokens');
	const output = attrNumber(attributes, 'gen_ai.usage.output_tokens');
	const cacheRead = attrNumber(attributes, 'gen_ai.usage.cache_read.input_tokens');
	const cacheCreation = attrNumberFirst(attributes, [
		'gen_ai.usage.cache_write.input_tokens',
		'gen_ai.usage.cache_creation.input_tokens',
	]);
	const reasoning = attrNumberFirst(attributes, [
		'gen_ai.usage.reasoning.output_tokens',
		'gen_ai.usage.reasoning_tokens',
	]);
	if (input + output + cacheRead + cacheCreation + reasoning === 0) {
		return undefined;
	}

	const traceId = traceIdFromRecord(record);
	const traceContext = traceId == null ? undefined : traceContexts.get(traceId);
	const responseId = attrString(attributes, 'gen_ai.response.id');
	const model = firstNonEmptyAttr(attributes, MODEL_ATTRS) ?? traceContext?.model ?? 'unknown';
	const sessionId =
		bestSessionAttr(attributes)?.[0] ?? traceContext?.sessionId ?? traceId ?? 'unknown-session';
	const timestampMs = timestampMsFromRecord(record) ?? fallbackTimestampMs;
	const inputTokens = Math.max(input - Math.min(input, cacheRead), 0);

	return {
		source,
		traceId,
		responseId,
		model,
		sessionId,
		timestampMs,
		inputTokens,
		outputTokens: output,
		cacheCreationTokens: cacheCreation,
		cacheReadTokens: cacheRead,
		reasoningOutputTokens: reasoning,
		dedupKey: dedupKeyForRecord(source, record, attributes, traceId, sessionId, timestampMs, index),
	};
}

function sourceTraceIds(
	candidates: readonly CopilotUsageCandidate[],
	source: CopilotUsageSource,
): Set<string> {
	return new Set(
		candidates
			.filter((candidate) => candidate.source === source)
			.map((candidate) => candidate.traceId)
			.filter((traceId) => traceId != null),
	);
}

function sourceResponseIds(
	candidates: readonly CopilotUsageCandidate[],
	source: CopilotUsageSource,
): Set<string> {
	return new Set(
		candidates
			.filter((candidate) => candidate.source === source)
			.map((candidate) => candidate.responseId)
			.filter((responseId) => responseId != null),
	);
}

function shouldEmitCandidate(
	candidate: CopilotUsageCandidate,
	sets: {
		chatTraces: ReadonlySet<string>;
		inferenceTraces: ReadonlySet<string>;
		agentTurnTraces: ReadonlySet<string>;
		chatResponseIds: ReadonlySet<string>;
		inferenceResponseIds: ReadonlySet<string>;
		agentTurnResponseIds: ReadonlySet<string>;
	},
): boolean {
	const traceMatch = (values: ReadonlySet<string>): boolean =>
		candidate.traceId != null && values.has(candidate.traceId);
	const responseMatch = (values: ReadonlySet<string>): boolean =>
		candidate.responseId != null && values.has(candidate.responseId);
	if (candidate.source === 'chat-span') {
		return true;
	}
	if (candidate.source === 'inference-log') {
		return !traceMatch(sets.chatTraces) && !responseMatch(sets.chatResponseIds);
	}
	if (candidate.source === 'agent-turn-log') {
		return (
			!traceMatch(sets.chatTraces) &&
			!traceMatch(sets.inferenceTraces) &&
			!responseMatch(sets.chatResponseIds) &&
			!responseMatch(sets.inferenceResponseIds)
		);
	}
	return (
		!traceMatch(sets.chatTraces) &&
		!traceMatch(sets.inferenceTraces) &&
		!traceMatch(sets.agentTurnTraces) &&
		!responseMatch(sets.chatResponseIds) &&
		!responseMatch(sets.inferenceResponseIds) &&
		!responseMatch(sets.agentTurnResponseIds)
	);
}

export async function parseCopilotOtelFile(filePath: string): Promise<CopilotUsageEntry[]> {
	const records: Record<string, unknown>[] = [];
	await processJSONLFileByMarkers(
		filePath,
		COPILOT_JSONL_MARKERS,
		(line) => {
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isRecord(parsed)) {
					records.push(parsed);
				}
			} catch {}
		},
		{ callbackMode: 'sync', scanMode: 'line' },
	);
	const traceContexts = collectTraceContexts(records);
	const fallbackTimestampMs = await fileModifiedTimestampMs(filePath);
	const candidates = records
		.map((record, index) => toCandidate(record, index, fallbackTimestampMs, traceContexts))
		.filter((candidate) => candidate != null);
	const sets = {
		chatTraces: sourceTraceIds(candidates, 'chat-span'),
		inferenceTraces: sourceTraceIds(candidates, 'inference-log'),
		agentTurnTraces: sourceTraceIds(candidates, 'agent-turn-log'),
		chatResponseIds: sourceResponseIds(candidates, 'chat-span'),
		inferenceResponseIds: sourceResponseIds(candidates, 'inference-log'),
		agentTurnResponseIds: sourceResponseIds(candidates, 'agent-turn-log'),
	};
	return candidates
		.filter((candidate) => shouldEmitCandidate(candidate, sets))
		.map((candidate) => ({
			timestamp: new Date(candidate.timestampMs).toISOString(),
			sessionId: candidate.sessionId,
			model: candidate.model,
			inputTokens: candidate.inputTokens,
			outputTokens: candidate.outputTokens,
			cacheCreationTokens: candidate.cacheCreationTokens,
			cacheReadTokens: candidate.cacheReadTokens,
			reasoningOutputTokens: candidate.reasoningOutputTokens,
			totalTokens:
				candidate.inputTokens +
				candidate.outputTokens +
				candidate.cacheCreationTokens +
				candidate.cacheReadTokens +
				candidate.reasoningOutputTokens,
			dedupKey: candidate.dedupKey,
		}));
}

function getCopilotWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function collectCopilotEntriesWithWorkers(
	files: string[],
): Promise<CopilotUsageEntry[][] | null> {
	const workerCount = getCopilotWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, CopilotUsageEntry[], CopilotWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'ccusage copilot worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:copilot-worker',
				items,
			}) satisfies CopilotWorkerData,
	});
}

export async function loadCopilotUsageEntries(): Promise<CopilotUsageEntry[]> {
	const files = await discoverCopilotOtelFiles();
	const entryGroups =
		(await collectCopilotEntriesWithWorkers(files)) ??
		(await mapWithConcurrency(
			files,
			getDefaultWorkerThreadCount(files.length),
			parseCopilotOtelFile,
		));
	return entryGroups.flat().sort((a, b) => compareStrings(a.timestamp, b.timestamp));
}

async function runCopilotWorker(data: CopilotWorkerData): Promise<void> {
	const results: CopilotWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await parseCopilotOtelFile(item),
		});
	}
	parentPort?.postMessage({ results } satisfies CopilotWorkerResponse);
}

function isCopilotWorkerData(value: unknown): value is CopilotWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:copilot-worker'
	);
}

if (!isMainThread && isCopilotWorkerData(workerData)) {
	void runCopilotWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('parseCopilotOtelFile', () => {
		it('loads Copilot chat spans from OTEL JSONL files', async () => {
			await using fixture = await createFixture({
				'copilot.jsonl': [
					JSON.stringify({ type: 'metric', name: 'gen_ai.client.token.usage' }),
					JSON.stringify({
						type: 'span',
						traceId: 'trace-1',
						spanId: 'span-1',
						name: 'chat claude-sonnet-4',
						endTime: [1_775_934_264, 967_317_833],
						attributes: {
							'gen_ai.operation.name': 'chat',
							'gen_ai.request.model': 'claude-sonnet-4',
							'gen_ai.response.model': 'claude-sonnet-4',
							'gen_ai.conversation.id': 'conv-1',
							'gen_ai.usage.input_tokens': 19_452,
							'gen_ai.usage.output_tokens': 281,
							'gen_ai.usage.cache_read.input_tokens': 123,
							'gen_ai.usage.cache_creation.input_tokens': 25,
							'gen_ai.usage.reasoning.output_tokens': 128,
						},
					}),
				].join('\n'),
			});

			await expect(parseCopilotOtelFile(fixture.getPath('copilot.jsonl'))).resolves.toEqual([
				{
					timestamp: '2026-04-11T19:04:24.967Z',
					sessionId: 'conv-1',
					model: 'claude-sonnet-4',
					inputTokens: 19_329,
					outputTokens: 281,
					cacheCreationTokens: 25,
					cacheReadTokens: 123,
					reasoningOutputTokens: 128,
					totalTokens: 19_886,
					dedupKey: 'trace-1:span-1',
				},
			]);
		});

		it('uses inference logs when chat spans are not available', async () => {
			await using fixture = await createFixture({
				'copilot.jsonl': `${JSON.stringify({
					hrTime: [1_775_934_264, 967_317_833],
					spanContext: { traceId: 'trace-log', spanId: 'span-log' },
					attributes: {
						'event.name': 'gen_ai.client.inference.operation.details',
						'gen_ai.response.model': 'gpt-5.4-mini',
						'gen_ai.response.id': 'response-log',
						'gen_ai.usage.input_tokens': 42,
						'gen_ai.usage.output_tokens': 7,
					},
					_body: 'GenAI inference: gpt-5.4-mini',
				})}\n`,
			});

			await expect(parseCopilotOtelFile(fixture.getPath('copilot.jsonl'))).resolves.toMatchObject([
				{
					sessionId: 'response-log',
					model: 'gpt-5.4-mini',
					inputTokens: 42,
					outputTokens: 7,
					dedupKey: 'log:trace-log:span-log',
				},
			]);
		});

		it('suppresses lower-priority records for the same trace or response', async () => {
			await using fixture = await createFixture({
				'copilot.jsonl': [
					JSON.stringify({
						type: 'span',
						traceId: 'trace-dupe',
						spanId: 'agent-1',
						name: 'invoke_agent GitHub Copilot Chat',
						attributes: {
							'gen_ai.operation.name': 'invoke_agent',
							'gen_ai.response.model': 'gpt-5.4-mini',
							'gen_ai.conversation.id': 'conv-dupe',
							'gen_ai.response.id': 'resp-dupe',
							'gen_ai.usage.input_tokens': 100,
							'gen_ai.usage.output_tokens': 30,
						},
					}),
					JSON.stringify({
						hrTime: [1_775_934_263, 0],
						attributes: {
							'event.name': 'gen_ai.client.inference.operation.details',
							'gen_ai.response.model': 'gpt-5.4-mini',
							'gen_ai.response.id': 'resp-dupe',
							'gen_ai.usage.input_tokens': 80,
							'gen_ai.usage.output_tokens': 20,
						},
						_body: 'GenAI inference: gpt-5.4-mini',
					}),
					JSON.stringify({
						type: 'span',
						traceId: 'trace-dupe',
						spanId: 'chat-1',
						name: 'chat gpt-5.4-mini',
						attributes: {
							'gen_ai.operation.name': 'chat',
							'gen_ai.response.model': 'gpt-5.4-mini',
							'gen_ai.conversation.id': 'conv-dupe',
							'gen_ai.response.id': 'resp-dupe',
							'gen_ai.usage.input_tokens': 60,
							'gen_ai.usage.output_tokens': 10,
						},
					}),
				].join('\n'),
			});

			await expect(parseCopilotOtelFile(fixture.getPath('copilot.jsonl'))).resolves.toMatchObject([
				{
					dedupKey: 'trace-dupe:chat-1',
					inputTokens: 60,
					outputTokens: 10,
				},
			]);
		});
	});
}
