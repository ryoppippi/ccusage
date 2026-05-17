import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import type { AmpLedgerEvent, AmpMessage, AmpThread, AmpUsageEvent } from './schema.ts';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readTextFile } from '@ccusage/internal/fs';
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
import { discoverAmpThreadFiles } from './paths.ts';
import { ampThreadSchema } from './schema.ts';

type AmpWorkerData = IndexedWorkerData<'ccusage:amp-worker', string>;

type AmpWorkerResponse = IndexedWorkerResultsMessage<AmpUsageEvent[]>;

function getAmpCacheTokens(
	messages: AmpMessage[] | undefined,
	toMessageId: number | undefined,
): { cacheCreationInputTokens: number; cacheReadInputTokens: number } {
	const message = messages?.find(
		(item) => item.role === 'assistant' && item.messageId === toMessageId,
	);
	return {
		cacheCreationInputTokens: message?.usage?.cacheCreationInputTokens ?? 0,
		cacheReadInputTokens: message?.usage?.cacheReadInputTokens ?? 0,
	};
}

function toAmpUsageEvent(thread: AmpThread, event: AmpLedgerEvent): AmpUsageEvent {
	const cacheTokens = getAmpCacheTokens(thread.messages, event.toMessageId);
	return {
		timestamp: event.timestamp,
		threadId: thread.id,
		model: event.model,
		credits: event.credits,
		inputTokens: event.tokens.input ?? 0,
		outputTokens: event.tokens.output ?? 0,
		...cacheTokens,
	};
}

async function loadAmpThreadEvents(filePath: string): Promise<AmpUsageEvent[]> {
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

	const threadResult = v.safeParse(ampThreadSchema, parseResult.value);
	if (!threadResult.success) {
		return [];
	}

	return (threadResult.output.usageLedger?.events ?? []).map((event) =>
		toAmpUsageEvent(threadResult.output, event),
	);
}

function getAmpWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function collectAmpEventsWithWorkers(files: string[]): Promise<AmpUsageEvent[][] | null> {
	const workerCount = getAmpWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, AmpUsageEvent[], AmpWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'ccusage amp worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:amp-worker',
				items,
			}) satisfies AmpWorkerData,
	});
}

export async function loadAmpUsageEvents(): Promise<AmpUsageEvent[]> {
	const files = await discoverAmpThreadFiles();
	const eventGroups =
		(await collectAmpEventsWithWorkers(files)) ??
		(await mapWithConcurrency(
			files,
			getDefaultWorkerThreadCount(files.length),
			loadAmpThreadEvents,
		));
	return eventGroups.flat().sort((a, b) => compareStrings(a.timestamp, b.timestamp));
}

async function runAmpWorker(data: AmpWorkerData): Promise<void> {
	const results: AmpWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await loadAmpThreadEvents(item),
		});
	}
	parentPort?.postMessage({ results } satisfies AmpWorkerResponse);
}

function isAmpWorkerData(value: unknown): value is AmpWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:amp-worker'
	);
}

if (!isMainThread && isAmpWorkerData(workerData)) {
	void runAmpWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('loadAmpUsageEvents', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads Amp thread usage events from real JSON files', async () => {
			await using fixture = await createFixture({
				threads: {
					'thread.json': JSON.stringify({
						id: 'thread-a',
						messages: [
							{
								role: 'assistant',
								messageId: 2,
								usage: {
									cacheCreationInputTokens: 20,
									cacheReadInputTokens: 10,
								},
							},
						],
						usageLedger: {
							events: [
								{
									timestamp: '2026-05-01T01:02:03.000Z',
									model: 'claude-sonnet-4-20250514',
									credits: 1.25,
									tokens: {
										input: 100,
										output: 50,
									},
									toMessageId: 2,
								},
							],
						},
					}),
				},
			});
			vi.stubEnv('AMP_DATA_DIR', fixture.path);

			await expect(loadAmpUsageEvents()).resolves.toEqual([
				{
					timestamp: '2026-05-01T01:02:03.000Z',
					threadId: 'thread-a',
					model: 'claude-sonnet-4-20250514',
					credits: 1.25,
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationInputTokens: 20,
					cacheReadInputTokens: 10,
				},
			]);
		});
	});
}
