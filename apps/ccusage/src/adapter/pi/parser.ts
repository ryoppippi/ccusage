import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import type { PiUsageEntry } from './schema.ts';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { collectFilesRecursive } from '@ccusage/internal/fs';
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
import { getPiAgentPaths } from './paths.ts';
import {
	extractPiAgentProject,
	extractPiAgentSessionId,
	piAgentMessageSchema,
	transformPiAgentUsage,
} from './schema.ts';

const PI_AGENT_JSONL_MARKERS = ['"usage"'];

type PiWorkerData = IndexedWorkerData<'ccusage:pi-usage-worker', string>;

type PiWorkerResponse = IndexedWorkerResultsMessage<PiUsageEntry[]>;

async function globPiAgentFiles(paths: string[]): Promise<string[]> {
	const allFiles: string[] = [];
	for (const basePath of paths) {
		const files = await collectFilesRecursive(basePath, { extension: '.jsonl' });
		allFiles.push(...files);
	}
	return allFiles;
}

function getJSONLWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function parsePiAgentFile(file: string): Promise<PiUsageEntry[]> {
	const project = extractPiAgentProject(file);
	const sessionId = extractPiAgentSessionId(file);
	const entries: PiUsageEntry[] = [];
	const result = await Result.try({
		try: processJSONLFileByMarkers(file, PI_AGENT_JSONL_MARKERS, (line) => {
			if (!line.includes('"message"')) {
				return;
			}

			const parseResult = Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) => error,
			})();
			if (Result.isFailure(parseResult)) {
				return;
			}

			const messageResult = v.safeParse(piAgentMessageSchema, parseResult.value);
			if (!messageResult.success) {
				return;
			}

			const usage = transformPiAgentUsage(messageResult.output);
			if (usage == null) {
				return;
			}

			entries.push({
				timestamp: messageResult.output.timestamp,
				project,
				sessionId,
				...usage,
			});
		}),
		catch: (error) => error,
	});
	return Result.isFailure(result) ? [] : entries;
}

async function collectWithPiWorkers(files: string[]): Promise<PiUsageEntry[][] | null> {
	const workerCount = getJSONLWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, PiUsageEntry[], PiWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'pi-agent usage worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:pi-usage-worker',
				items,
			}) satisfies PiWorkerData,
	});
}

export async function loadPiUsageEntries(piPath?: string): Promise<PiUsageEntry[]> {
	const piPaths = getPiAgentPaths(piPath);
	if (piPaths.length === 0) {
		return [];
	}

	const files = await globPiAgentFiles(piPaths);
	if (files.length === 0) {
		return [];
	}

	const processedHashes = new Set<string>();
	const entries: PiUsageEntry[] = [];
	const fileResults =
		(await collectWithPiWorkers(files)) ??
		(await mapWithConcurrency(files, getDefaultWorkerThreadCount(files.length), parsePiAgentFile));

	for (const fileEntries of fileResults) {
		for (const entry of fileEntries) {
			const hash = [
				'pi',
				entry.project,
				entry.sessionId,
				entry.timestamp,
				entry.model,
				entry.inputTokens,
				entry.outputTokens,
				entry.cacheCreationTokens,
				entry.cacheReadTokens,
				entry.cost,
				entry.tokenTotal,
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

async function runPiUsageWorker(data: PiWorkerData): Promise<void> {
	const results: PiWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await parsePiAgentFile(item),
		});
	}
	parentPort?.postMessage({ results } satisfies PiWorkerResponse);
}

function isPiWorkerData(value: unknown): value is PiWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:pi-usage-worker'
	);
}

if (!isMainThread && isPiWorkerData(workerData)) {
	void runPiUsageWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('loadPiUsageEntries', () => {
		it('loads assistant usage entries from real JSONL files', async () => {
			await using fixture = await createFixture({
				sessions: {
					project: {
						'session-id.jsonl': [
							JSON.stringify({
								type: 'message',
								timestamp: '2026-04-22T01:02:03.000Z',
								message: {
									role: 'user',
									usage: {
										input: 999,
										output: 999,
									},
								},
							}),
							JSON.stringify({
								type: 'message',
								timestamp: '2026-04-22T01:02:04.000Z',
								message: {
									role: 'assistant',
									model: 'gpt-5.4',
									usage: {
										input: 100,
										output: 50,
										cacheRead: 10,
										cacheWrite: 20,
										totalTokens: 180,
										cost: { total: 0.05 },
									},
								},
							}),
						].join('\n'),
					},
				},
			});

			await expect(loadPiUsageEntries(fixture.getPath('sessions'))).resolves.toEqual([
				{
					timestamp: '2026-04-22T01:02:04.000Z',
					model: '[pi] gpt-5.4',
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					cost: 0.05,
					project: 'project',
					sessionId: 'session-id',
					tokenTotal: 180,
				},
			]);
		});

		it('loads assistant usage entries from comma-separated explicit paths', async () => {
			const createMessage = (input: number): string =>
				`${JSON.stringify({
					type: 'message',
					timestamp: '2026-04-22T01:02:04.000Z',
					message: {
						role: 'assistant',
						model: 'gpt-5.4',
						usage: {
							input,
							output: 1,
							totalTokens: input + 1,
						},
					},
				})}\n`;
			await using fixture1 = await createFixture({
				sessions: {
					project: {
						'a.jsonl': createMessage(10),
					},
				},
			});
			await using fixture2 = await createFixture({
				sessions: {
					project: {
						'b.jsonl': createMessage(20),
					},
				},
			});

			await expect(
				loadPiUsageEntries(`${fixture1.getPath('sessions')},${fixture2.getPath('sessions')}`),
			).resolves.toMatchObject([{ inputTokens: 10 }, { inputTokens: 20 }]);
		});

		it('deduplicates repeated pi usage records by project, session, timestamp, and total tokens', async () => {
			const line = JSON.stringify({
				type: 'message',
				timestamp: '2026-04-22T01:02:04.000Z',
				message: {
					role: 'assistant',
					model: 'gpt-5.4',
					usage: {
						input: 100,
						output: 50,
						totalTokens: 150,
					},
				},
			});
			await using fixture = await createFixture({
				sessions: {
					project: {
						'session-id.jsonl': `${line}\n${line}\n`,
					},
				},
			});

			await expect(loadPiUsageEntries(fixture.getPath('sessions'))).resolves.toHaveLength(1);
		});

		it('keeps distinct pi usage records that share timestamp and total tokens but differ in token breakdown', async () => {
			const base = {
				type: 'message',
				timestamp: '2026-04-22T01:02:04.000Z',
				message: {
					role: 'assistant',
					model: 'gpt-5.4',
				},
			};
			await using fixture = await createFixture({
				sessions: {
					project: {
						'session-id.jsonl': [
							JSON.stringify({
								...base,
								message: {
									...base.message,
									usage: {
										input: 100,
										output: 50,
										totalTokens: 150,
									},
								},
							}),
							JSON.stringify({
								...base,
								message: {
									...base.message,
									usage: {
										input: 90,
										output: 60,
										totalTokens: 150,
									},
								},
							}),
						].join('\n'),
					},
				},
			});

			await expect(loadPiUsageEntries(fixture.getPath('sessions'))).resolves.toHaveLength(2);
		});

		it.skipIf(getPiAgentPaths().length === 0)(
			'loads local pi-agent usage data when the user has a sessions directory',
			async () => {
				const rows = await loadPiUsageEntries();

				expect(rows.length).toBeGreaterThan(0);
			},
		);
	});
}
