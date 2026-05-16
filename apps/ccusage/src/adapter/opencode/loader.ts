import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import type {
	OpenCodeMessage,
	OpenCodeMessageResult,
	OpenCodeTokens,
	OpenCodeUsageEntry,
} from './schema.ts';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readTextFile } from '@ccusage/internal/fs';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import {
	collectIndexedFileWorkerResults,
	getFileWorkerThreadCount,
} from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import { logger } from '../../logger.ts';
import { discoverOpenCodeMessageFiles, getOpenCodeDbPath, getOpenCodePath } from './paths.ts';
import { openCodeDbMessageRowSchema, openCodeMessageSchema } from './schema.ts';

type OpenCodeWorkerData = IndexedWorkerData<'ccusage:opencode-worker', string>;

type OpenCodeWorkerResponse = IndexedWorkerResultsMessage<OpenCodeMessageResult | null>;

function parseJsonObject(value: string): Record<string, unknown> | null {
	const result = Result.try({
		try: () => JSON.parse(value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		return null;
	}
	if (typeof result.value !== 'object' || result.value == null || Array.isArray(result.value)) {
		return null;
	}
	return result.value as Record<string, unknown>;
}

function hasBillableTokenUsage(tokens: OpenCodeTokens): boolean {
	return (
		(tokens.input ?? 0) > 0 ||
		(tokens.output ?? 0) > 0 ||
		(tokens.reasoning ?? 0) > 0 ||
		(tokens.cache?.read ?? 0) > 0 ||
		(tokens.cache?.write ?? 0) > 0
	);
}

function shouldLoadOpenCodeMessage(message: OpenCodeMessage): boolean {
	return (
		message.tokens != null &&
		hasBillableTokenUsage(message.tokens) &&
		message.providerID != null &&
		message.modelID != null
	);
}

function convertOpenCodeMessageToUsageEntry(message: OpenCodeMessage): OpenCodeUsageEntry {
	return {
		timestamp: new Date(message.time.created ?? Date.now()),
		sessionID: message.sessionID ?? 'unknown',
		usage: {
			inputTokens: message.tokens?.input ?? 0,
			outputTokens: message.tokens?.output ?? 0,
			cacheCreationInputTokens: message.tokens?.cache?.write ?? 0,
			cacheReadInputTokens: message.tokens?.cache?.read ?? 0,
		},
		model: message.modelID ?? 'unknown',
		providerID: message.providerID ?? 'unknown',
		costUSD: message.cost ?? null,
	};
}

function parseOpenCodeMessageRecord(value: unknown): OpenCodeMessageResult | null {
	const parsed = v.safeParse(openCodeMessageSchema, value);
	if (!parsed.success || !shouldLoadOpenCodeMessage(parsed.output)) {
		return null;
	}
	return {
		id: parsed.output.id,
		entry: convertOpenCodeMessageToUsageEntry(parsed.output),
	};
}

function parseOpenCodeMessageText(value: string): OpenCodeMessageResult | null {
	const data = parseJsonObject(value);
	return data == null ? null : parseOpenCodeMessageRecord(data);
}

async function loadOpenCodeMessageFile(filePath: string): Promise<OpenCodeMessageResult | null> {
	const content = await Result.try({
		try: readTextFile(filePath),
		catch: (error) => error,
	});
	return Result.isFailure(content) ? null : parseOpenCodeMessageText(content.value);
}

function getOpenCodeWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function collectOpenCodeMessagesWithWorkers(
	files: string[],
): Promise<Array<OpenCodeMessageResult | null> | null> {
	const workerCount = getOpenCodeWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, OpenCodeMessageResult | null, OpenCodeWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'ccusage opencode worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:opencode-worker',
				items,
			}) satisfies OpenCodeWorkerData,
	});
}

function loadOpenCodeMessagesFromDb(openCodePath: string): {
	entries: OpenCodeUsageEntry[];
	seenIds: Set<string>;
} {
	const dbPath = getOpenCodeDbPath(openCodePath);
	if (dbPath == null || getSqliteDatabaseFactory() == null) {
		return { entries: [], seenIds: new Set() };
	}

	const result = Result.try({
		try: () =>
			withSqliteDatabase(
				dbPath,
				{ readOnly: true },
				(db) => {
					const rows = db.prepare('SELECT id, session_id, data FROM message').all();
					const entries: OpenCodeUsageEntry[] = [];
					const seenIds = new Set<string>();
					for (const rawRow of rows) {
						const rowResult = v.safeParse(openCodeDbMessageRowSchema, rawRow);
						if (!rowResult.success) {
							continue;
						}

						const data = parseJsonObject(rowResult.output.data);
						if (data == null) {
							continue;
						}

						const result = parseOpenCodeMessageRecord({
							...data,
							id: rowResult.output.id,
							sessionID: rowResult.output.session_id,
						});
						if (result == null) {
							continue;
						}

						seenIds.add(result.id);
						entries.push(result.entry);
					}
					return { entries, seenIds };
				},
				logger.warn,
			),
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		logger.warn('Failed to load OpenCode messages from DB:', result.error);
		return { entries: [], seenIds: new Set() };
	}
	return result.value ?? { entries: [], seenIds: new Set() };
}

export async function loadOpenCodeMessages(): Promise<OpenCodeUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const { entries, seenIds } = loadOpenCodeMessagesFromDb(openCodePath);
	const files = await discoverOpenCodeMessageFiles(openCodePath);
	const messageResults =
		(await collectOpenCodeMessagesWithWorkers(files)) ??
		(await Promise.all(files.map(loadOpenCodeMessageFile)));
	for (const result of messageResults) {
		if (result == null || seenIds.has(result.id)) {
			continue;
		}
		seenIds.add(result.id);
		entries.push(result.entry);
	}

	return entries;
}

async function runOpenCodeWorker(data: OpenCodeWorkerData): Promise<void> {
	const results: OpenCodeWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await loadOpenCodeMessageFile(item),
		});
	}
	parentPort?.postMessage({ results } satisfies OpenCodeWorkerResponse);
}

function isOpenCodeWorkerData(value: unknown): value is OpenCodeWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:opencode-worker'
	);
}

if (!isMainThread && isOpenCodeWorkerData(workerData)) {
	void runOpenCodeWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('loadOpenCodeMessages', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads OpenCode message JSON files', async () => {
			await using fixture = await createFixture({
				storage: {
					message: {
						'message.json': JSON.stringify({
							id: 'msg-1',
							sessionID: 'session-a',
							providerID: 'openai',
							modelID: 'gpt-5',
							time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
							tokens: {
								input: 100,
								output: 50,
								cache: {
									write: 20,
									read: 10,
								},
							},
							cost: 0.02,
						}),
					},
				},
			});
			vi.stubEnv('OPENCODE_DATA_DIR', fixture.path);

			await expect(loadOpenCodeMessages()).resolves.toMatchObject([
				{
					sessionID: 'session-a',
					model: 'gpt-5',
					providerID: 'openai',
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationInputTokens: 20,
						cacheReadInputTokens: 10,
					},
					costUSD: 0.02,
				},
			]);
		});

		it('loads billable OpenCode messages without cache token fields', async () => {
			await using fixture = await createFixture({
				storage: {
					message: {
						'message.json': JSON.stringify({
							id: 'msg-1',
							sessionID: 'session-a',
							providerID: 'openai',
							modelID: 'gpt-5',
							time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
							tokens: {
								input: 100,
								output: 50,
							},
						}),
					},
				},
			});
			vi.stubEnv('OPENCODE_DATA_DIR', fixture.path);

			await expect(loadOpenCodeMessages()).resolves.toMatchObject([
				{
					sessionID: 'session-a',
					model: 'gpt-5',
					providerID: 'openai',
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
				},
			]);
		});

		it('ignores non-billable OpenCode message files', async () => {
			await using fixture = await createFixture({
				storage: {
					message: {
						'message.json': JSON.stringify({
							id: 'msg-1',
							sessionID: 'session-a',
							providerID: 'openai',
							modelID: 'gpt-5',
							time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
							tokens: {
								input: 0,
								output: 0,
								cache: {
									write: 0,
									read: 0,
								},
							},
						}),
					},
				},
			});
			vi.stubEnv('OPENCODE_DATA_DIR', fixture.path);

			await expect(loadOpenCodeMessages()).resolves.toEqual([]);
		});
	});
}
