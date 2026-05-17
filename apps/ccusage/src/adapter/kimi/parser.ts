import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import type { KimiUsageEntry, KimiWireLine } from './schema.ts';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readTextFile } from '@ccusage/internal/fs';
import { processJSONLFileByMarkers } from '@ccusage/internal/jsonl';
import { compareStrings } from '@ccusage/internal/sort';
import {
	collectIndexedFileWorkerResults,
	getDefaultWorkerThreadCount,
	getFileWorkerThreadCount,
	mapWithConcurrency,
} from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import { discoverKimiWireFiles } from './paths.ts';
import { kimiWireLineSchema } from './schema.ts';

const KIMI_JSONL_MARKERS = ['"StatusUpdate"', '"token_usage"'];
const DEFAULT_MODEL = 'kimi-for-coding';
const DEFAULT_PROVIDER = 'moonshot';

type KimiWorkerData = IndexedWorkerData<'ccusage:kimi-wire-worker', string>;

type KimiWorkerResponse = IndexedWorkerResultsMessage<KimiUsageEntry[]>;

function toNonNegativeInteger(value: number | undefined): number {
	if (value == null || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(Math.trunc(value), 0);
}

function toIsoTimestamp(timestampSeconds: number | undefined, fallback: string): string {
	if (timestampSeconds == null || !Number.isFinite(timestampSeconds)) {
		return fallback;
	}
	const date = new Date(Math.trunc(timestampSeconds * 1000));
	if (Number.isNaN(date.valueOf())) {
		return fallback;
	}
	return date.toISOString();
}

function extractKimiSessionId(filePath: string): string {
	const sessionId = path.basename(path.dirname(filePath));
	return sessionId === '' ? 'unknown' : sessionId;
}

function getKimiRootFromWirePath(filePath: string): string | undefined {
	return path.dirname(path.dirname(path.dirname(path.dirname(filePath))));
}

async function getFileModifiedTimestamp(filePath: string): Promise<string> {
	const result = await Result.try({
		try: async () => stat(filePath),
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		return new Date(0).toISOString();
	}
	return result.value.mtime.toISOString();
}

async function readKimiModelFromConfig(filePath: string): Promise<string> {
	const kimiRoot = getKimiRootFromWirePath(filePath);
	if (kimiRoot == null) {
		return DEFAULT_MODEL;
	}
	const result = await Result.try({
		try: async () => JSON.parse(await readTextFile(path.join(kimiRoot, 'config.json'))) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		return DEFAULT_MODEL;
	}
	if (
		result.value != null &&
		typeof result.value === 'object' &&
		'model' in result.value &&
		typeof result.value.model === 'string' &&
		result.value.model.trim() !== ''
	) {
		return result.value.model;
	}
	return DEFAULT_MODEL;
}

function toKimiUsageEntry(
	wireLine: KimiWireLine,
	filePath: string,
	model: string,
	fallbackTimestamp: string,
): KimiUsageEntry | undefined {
	if (wireLine.type === 'metadata' || wireLine.message?.type !== 'StatusUpdate') {
		return undefined;
	}
	const tokenUsage = wireLine.message.payload?.token_usage;
	if (tokenUsage == null) {
		return undefined;
	}
	const entry = {
		timestamp: toIsoTimestamp(wireLine.timestamp, fallbackTimestamp),
		sessionId: extractKimiSessionId(filePath),
		model,
		provider: DEFAULT_PROVIDER,
		messageId: wireLine.message.payload?.message_id,
		inputTokens: toNonNegativeInteger(tokenUsage.input_other),
		outputTokens: toNonNegativeInteger(tokenUsage.output),
		cacheCreationTokens: toNonNegativeInteger(tokenUsage.input_cache_creation),
		cacheReadTokens: toNonNegativeInteger(tokenUsage.input_cache_read),
	} satisfies KimiUsageEntry;
	if (
		entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens ===
		0
	) {
		return undefined;
	}
	return entry;
}

async function parseKimiWireFile(filePath: string): Promise<KimiUsageEntry[]> {
	const model = await readKimiModelFromConfig(filePath);
	const fallbackTimestamp = await getFileModifiedTimestamp(filePath);
	const entries: KimiUsageEntry[] = [];
	const result = await Result.try({
		try: processJSONLFileByMarkers(filePath, KIMI_JSONL_MARKERS, (line) => {
			const parseResult = Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) => error,
			})();
			if (Result.isFailure(parseResult)) {
				return;
			}
			const wireLineResult = v.safeParse(kimiWireLineSchema, parseResult.value);
			if (!wireLineResult.success) {
				return;
			}
			const entry = toKimiUsageEntry(wireLineResult.output, filePath, model, fallbackTimestamp);
			if (entry != null) {
				entries.push(entry);
			}
		}),
		catch: (error) => error,
	});
	return Result.isFailure(result) ? [] : entries;
}

function getKimiWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function collectKimiEntriesWithWorkers(files: string[]): Promise<KimiUsageEntry[][] | null> {
	const workerCount = getKimiWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, KimiUsageEntry[], KimiWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'ccusage kimi worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:kimi-wire-worker',
				items,
			}) satisfies KimiWorkerData,
	});
}

export async function loadKimiUsageEntries(): Promise<KimiUsageEntry[]> {
	const files = await discoverKimiWireFiles();
	const fileResults =
		(await collectKimiEntriesWithWorkers(files)) ??
		(await mapWithConcurrency(files, getDefaultWorkerThreadCount(files.length), parseKimiWireFile));
	const processedKeys = new Set<string>();
	const entries: KimiUsageEntry[] = [];
	for (const fileEntries of fileResults) {
		for (const entry of fileEntries) {
			const key = [
				entry.sessionId,
				entry.messageId,
				entry.timestamp,
				entry.model,
				entry.inputTokens,
				entry.outputTokens,
				entry.cacheCreationTokens,
				entry.cacheReadTokens,
			].join(':');
			if (processedKeys.has(key)) {
				continue;
			}
			processedKeys.add(key);
			entries.push(entry);
		}
	}
	return entries.sort((a, b) => compareStrings(a.timestamp, b.timestamp));
}

async function runKimiWorker(data: KimiWorkerData): Promise<void> {
	const results: KimiWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await parseKimiWireFile(item),
		});
	}
	parentPort?.postMessage({ results } satisfies KimiWorkerResponse);
}

function isKimiWorkerData(value: unknown): value is KimiWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:kimi-wire-worker'
	);
}

if (!isMainThread && isKimiWorkerData(workerData)) {
	void runKimiWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('loadKimiUsageEntries', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads StatusUpdate token usage from Kimi wire files', async () => {
			await using fixture = await createFixture({
				'config.json': JSON.stringify({ model: 'kimi-k2' }),
				sessions: {
					group: {
						'session-a': {
							'wire.jsonl': [
								JSON.stringify({ type: 'metadata', protocol_version: '1.3' }),
								JSON.stringify({
									timestamp: 1_770_983_426.420942,
									message: {
										type: 'TurnBegin',
										payload: { user_input: 'hello' },
									},
								}),
								JSON.stringify({
									timestamp: 1_770_983_427.123,
									message: {
										type: 'StatusUpdate',
										payload: {
											token_usage: {
												input_other: 100,
												output: 50,
												input_cache_read: 10,
												input_cache_creation: 20,
											},
											message_id: 'msg-1',
										},
									},
								}),
							].join('\n'),
						},
					},
				},
			});
			vi.stubEnv('KIMI_DATA_DIR', fixture.path);

			await expect(loadKimiUsageEntries()).resolves.toEqual([
				{
					timestamp: '2026-02-13T11:50:27.123Z',
					sessionId: 'session-a',
					model: 'kimi-k2',
					provider: 'moonshot',
					messageId: 'msg-1',
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
				},
			]);
		});

		it('skips malformed and zero-token wire lines', async () => {
			await using fixture = await createFixture({
				sessions: {
					group: {
						'session-a': {
							'wire.jsonl': [
								'not json',
								JSON.stringify({
									timestamp: 1_770_983_427,
									message: {
										type: 'StatusUpdate',
										payload: {
											token_usage: {
												input_other: 0,
												output: 0,
												input_cache_read: 0,
												input_cache_creation: 0,
											},
										},
									},
								}),
							].join('\n'),
						},
					},
				},
			});
			vi.stubEnv('KIMI_DATA_DIR', fixture.path);

			await expect(loadKimiUsageEntries()).resolves.toEqual([]);
		});
	});
}
