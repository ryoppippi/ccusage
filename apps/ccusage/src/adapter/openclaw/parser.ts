import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import type { OpenClawUsageEntry } from './schema.ts';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { collectFilesRecursive, hasFileRecursive } from '@ccusage/internal/fs';
import { processJSONLFileByMarkers } from '@ccusage/internal/jsonl';
import {
	collectIndexedFileWorkerResults,
	getDefaultWorkerThreadCount,
	getFileWorkerThreadCount,
	mapWithConcurrency,
} from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import { getOpenClawPaths } from './paths.ts';
import {
	extractOpenClawSessionId,
	getModelFromChange,
	isAssistantMessageEntry,
	isModelChangeEntry,
	openClawEntrySchema,
	toIsoTimestamp,
} from './schema.ts';

const OPENCLAW_JSONL_MARKERS = ['"model_change"', '"model-snapshot"', '"usage"'];

type OpenClawWorkerData = IndexedWorkerData<'ccusage:openclaw-worker', string>;
type OpenClawWorkerResponse = IndexedWorkerResultsMessage<OpenClawUsageEntry[]>;

function isOpenClawSessionFile(name: string): boolean {
	const jsonlIndex = name.indexOf('.jsonl');
	if (jsonlIndex === -1) {
		return false;
	}
	const suffix = name.slice(jsonlIndex);
	if (suffix === '.jsonl') {
		return true;
	}
	return suffix.startsWith('.jsonl.deleted.') || suffix.startsWith('.jsonl.reset.');
}

async function collectOpenClawFiles(roots: string[]): Promise<string[]> {
	const allFiles: string[] = [];
	for (const root of roots) {
		const files = await collectFilesRecursive(root);
		for (const file of files) {
			const name = file.slice(file.lastIndexOf('/') + 1);
			if (isOpenClawSessionFile(name)) {
				allFiles.push(file);
			}
		}
	}
	return allFiles;
}

export async function hasOpenClawSessionFiles(roots: string[]): Promise<boolean> {
	for (const root of roots) {
		const hasJsonl = await hasFileRecursive(root, { extension: '.jsonl' });
		if (hasJsonl) {
			return true;
		}
	}
	return false;
}

function getOpenClawWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function parseOpenClawFile(file: string): Promise<OpenClawUsageEntry[]> {
	const sessionId = extractOpenClawSessionId(file);
	const entries: OpenClawUsageEntry[] = [];
	let currentModel: string | undefined;
	let currentProvider: string | undefined;
	const fallbackTimestamp = new Date().toISOString();

	const result = await Result.try({
		try: processJSONLFileByMarkers(file, OPENCLAW_JSONL_MARKERS, (line) => {
			const parseResult = Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) => error,
			})();
			if (Result.isFailure(parseResult)) {
				return;
			}

			const entryResult = v.safeParse(openClawEntrySchema, parseResult.value);
			if (!entryResult.success) {
				return;
			}
			const entry = entryResult.output;

			if (isModelChangeEntry(entry)) {
				const { model, provider } = getModelFromChange(entry);
				if (model != null) {
					currentModel = model;
				}
				if (provider != null) {
					currentProvider = provider;
				}
				return;
			}

			if (!isAssistantMessageEntry(entry)) {
				return;
			}

			const message = entry.message!;
			const usage = message.usage!;
			const messageModel = message.modelId ?? message.model ?? currentModel;
			const messageProvider = message.provider ?? currentProvider;

			const inputTokens = usage.input ?? 0;
			const outputTokens = usage.output ?? 0;
			const cacheReadTokens = usage.cacheRead ?? 0;
			const cacheCreationTokens = usage.cacheWrite ?? 0;
			const tokenTotal =
				usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
			const cost = usage.cost?.total ?? 0;

			entries.push({
				timestamp: toIsoTimestamp(message.timestamp ?? entry.timestamp, fallbackTimestamp),
				sessionId,
				model: messageModel == null ? '[openclaw] unknown' : `[openclaw] ${messageModel}`,
				provider: messageProvider,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				tokenTotal,
				cost,
			});
		}),
		catch: (error) => error,
	});

	return Result.isFailure(result) ? [] : entries;
}

async function collectWithOpenClawWorkers(files: string[]): Promise<OpenClawUsageEntry[][] | null> {
	const workerCount = getOpenClawWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, OpenClawUsageEntry[], OpenClawWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'openclaw usage worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:openclaw-worker',
				items,
			}) satisfies OpenClawWorkerData,
	});
}

export async function loadOpenClawUsageEntries(
	openClawPath?: string,
): Promise<OpenClawUsageEntry[]> {
	const roots = getOpenClawPaths(openClawPath);
	if (roots.length === 0) {
		return [];
	}

	const files = await collectOpenClawFiles(roots);
	if (files.length === 0) {
		return [];
	}

	const processedHashes = new Set<string>();
	const entries: OpenClawUsageEntry[] = [];
	const fileResults =
		(await collectWithOpenClawWorkers(files)) ??
		(await mapWithConcurrency(files, getDefaultWorkerThreadCount(files.length), parseOpenClawFile));

	for (const fileEntries of fileResults) {
		for (const entry of fileEntries) {
			const hash = [
				'openclaw',
				entry.sessionId,
				entry.timestamp,
				entry.model,
				entry.inputTokens,
				entry.outputTokens,
				entry.cacheCreationTokens,
				entry.cacheReadTokens,
				entry.tokenTotal,
				entry.cost,
			].join(':');
			if (processedHashes.has(hash)) {
				continue;
			}
			processedHashes.add(hash);
			entries.push(entry);
		}
	}

	return entries;
}

async function runOpenClawWorker(data: OpenClawWorkerData): Promise<void> {
	const results: OpenClawWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await parseOpenClawFile(item),
		});
	}
	parentPort?.postMessage({ results } satisfies OpenClawWorkerResponse);
}

function isOpenClawWorkerData(value: unknown): value is OpenClawWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:openclaw-worker'
	);
}

if (!isMainThread && isOpenClawWorkerData(workerData)) {
	void runOpenClawWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('loadOpenClawUsageEntries', () => {
		it('loads assistant usage and uses model_change events for the model', async () => {
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'abc.jsonl': [
								JSON.stringify({
									type: 'model_change',
									provider: 'openai-codex',
									modelId: 'gpt-5.2',
								}),
								JSON.stringify({
									type: 'message',
									message: {
										role: 'assistant',
										usage: {
											input: 1660,
											output: 55,
											cacheRead: 108928,
											cost: { total: 0.02 },
										},
										timestamp: 1769753935279,
									},
								}),
							].join('\n'),
						},
					},
				},
			});

			await expect(loadOpenClawUsageEntries(fixture.path)).resolves.toEqual([
				{
					timestamp: '2026-01-30T06:18:55.279Z',
					sessionId: 'abc',
					model: '[openclaw] gpt-5.2',
					provider: 'openai-codex',
					inputTokens: 1660,
					outputTokens: 55,
					cacheCreationTokens: 0,
					cacheReadTokens: 108928,
					tokenTotal: 110643,
					cost: 0.02,
				},
			]);
		});

		it('honors custom model-snapshot entries via the data envelope', async () => {
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'session.jsonl': [
								JSON.stringify({
									type: 'custom',
									customType: 'model-snapshot',
									data: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
								}),
								JSON.stringify({
									type: 'message',
									message: {
										role: 'assistant',
										usage: { input: 10, output: 5, totalTokens: 15 },
										timestamp: 1769753935279,
									},
								}),
							].join('\n'),
						},
					},
				},
			});

			await expect(loadOpenClawUsageEntries(fixture.path)).resolves.toMatchObject([
				{
					model: '[openclaw] claude-sonnet-4',
					provider: 'anthropic',
					tokenTotal: 15,
				},
			]);
		});

		it('reads sessions from archived .jsonl.deleted and .jsonl.reset files', async () => {
			const line = JSON.stringify({
				type: 'message',
				message: {
					role: 'assistant',
					model: 'gpt-5.2',
					usage: { input: 1, output: 1, totalTokens: 2 },
					timestamp: 1769753935279,
				},
			});
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'a.jsonl.deleted.1700000000000': line,
							'b.jsonl.reset.2026-03-20T06-34-44.520Z': line,
						},
					},
				},
			});

			await expect(loadOpenClawUsageEntries(fixture.path)).resolves.toHaveLength(2);
		});

		it('ignores user messages and entries without usage', async () => {
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'session.jsonl': [
								JSON.stringify({
									type: 'message',
									message: {
										role: 'user',
										usage: { input: 1, output: 1 },
										timestamp: 1769753935279,
									},
								}),
								JSON.stringify({
									type: 'message',
									message: { role: 'assistant', timestamp: 1769753935279 },
								}),
							].join('\n'),
						},
					},
				},
			});

			await expect(loadOpenClawUsageEntries(fixture.path)).resolves.toEqual([]);
		});

		it('deduplicates repeated openclaw records by hash', async () => {
			const line = JSON.stringify({
				type: 'message',
				message: {
					role: 'assistant',
					model: 'gpt-5.2',
					usage: { input: 1, output: 1, totalTokens: 2 },
					timestamp: 1769753935279,
				},
			});
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'session.jsonl': `${line}\n${line}\n`,
						},
					},
				},
			});

			await expect(loadOpenClawUsageEntries(fixture.path)).resolves.toHaveLength(1);
		});

		it.skipIf(getOpenClawPaths().length === 0)(
			'loads local openclaw usage data when the user has one of the supported directories',
			async () => {
				const rows = await loadOpenClawUsageEntries();
				expect(rows.length).toBeGreaterThanOrEqual(0);
			},
		);
	});
}
