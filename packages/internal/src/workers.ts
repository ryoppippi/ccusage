import { stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createFixture } from 'fs-fixture';
import { createResultSlots } from './array.ts';

export type IndexedWorkerItem<T> = {
	index: number;
	item: T;
};

export type IndexedWorkerResult<TResult> = {
	index: number;
	result: TResult;
};

type FileWorkerLike<TResult> = {
	once: ((
		event: 'message',
		listener: (message: { results: Array<IndexedWorkerResult<TResult>> }) => void,
	) => FileWorkerLike<TResult>) &
		((event: 'error', listener: (error: Error) => void) => FileWorkerLike<TResult>) &
		((event: 'exit', listener: (code: number) => void) => FileWorkerLike<TResult>);
};

export function getDefaultWorkerThreadCount(
	itemCount: number,
	options: {
		maxWorkers?: number;
		preferMoreWorkers?: boolean;
	} = {},
): number {
	const available = Math.max(1, availableParallelism() - 1);
	const workerCount = Math.min(
		options.preferMoreWorkers === true ? Math.ceil(available * 0.75) : Math.ceil(available / 2),
		options.maxWorkers ?? 12,
	);
	return Math.min(itemCount, Math.max(1, workerCount));
}

export function getFileWorkerThreadCount(options: {
	itemCount: number;
	isMainThread: boolean;
	moduleUrl: string;
	minItems?: number;
	envValue?: string;
	isTest?: boolean;
	maxWorkers?: number;
	preferMoreWorkers?: boolean;
}): number {
	if (
		options.itemCount < (options.minItems ?? 64) ||
		!options.isMainThread ||
		options.isTest === true ||
		!options.moduleUrl.includes('/dist/')
	) {
		return 0;
	}

	const configured = Number.parseInt(options.envValue ?? '', 10);
	if (Number.isFinite(configured)) {
		if (configured <= 0) {
			return 0;
		}
		return Math.min(options.itemCount, configured);
	}

	return getDefaultWorkerThreadCount(options.itemCount, {
		maxWorkers: options.maxWorkers,
		preferMoreWorkers: options.preferMoreWorkers,
	});
}

export async function chunkIndexedItemsByFileSize<T>(
	items: Array<IndexedWorkerItem<T>>,
	chunkCount: number,
	getFilePath: (item: T) => string,
): Promise<Array<Array<IndexedWorkerItem<T>>>> {
	if (!Number.isInteger(chunkCount) || chunkCount <= 0 || items.length === 0) {
		return [];
	}

	const weightedItems = await Promise.all(
		items.map(async (item) => {
			try {
				return { item, weight: (await stat(getFilePath(item.item))).size };
			} catch {
				return { item, weight: 0 };
			}
		}),
	);

	weightedItems.sort((a, b) => b.weight - a.weight || a.item.index - b.item.index);

	const chunks: Array<Array<IndexedWorkerItem<T>>> = Array.from({ length: chunkCount }, () => []);
	const chunkWeights = Array.from<number>({ length: chunkCount }).fill(0);
	for (const { item, weight } of weightedItems) {
		let targetIndex = 0;
		for (let index = 1; index < chunkWeights.length; index++) {
			if (chunkWeights[index]! < chunkWeights[targetIndex]!) {
				targetIndex = index;
			}
		}
		chunks[targetIndex]!.push(item);
		chunkWeights[targetIndex]! += weight;
	}

	return chunks.filter((chunk) => chunk.length > 0);
}

export async function collectIndexedFileWorkerResults<TItem, TResult, TWorkerData>(options: {
	items: TItem[];
	workerCount: number;
	moduleUrl: string;
	errorMessage: string;
	createWorkerData: (items: Array<IndexedWorkerItem<TItem>>) => TWorkerData;
	getFilePath?: (item: TItem) => string;
	createWorker?: (moduleUrl: URL, workerData: TWorkerData) => FileWorkerLike<TResult>;
}): Promise<TResult[] | null> {
	if (options.workerCount === 0) {
		return null;
	}

	const indexedItems = options.items.map<IndexedWorkerItem<TItem>>((item, index) => ({
		index,
		item,
	}));
	const chunks = await chunkIndexedItemsByFileSize(
		indexedItems,
		options.workerCount,
		options.getFilePath ?? String,
	);
	const createWorker =
		options.createWorker ??
		((moduleUrl, workerData) => new Worker(moduleUrl, { workerData }) as FileWorkerLike<TResult>);
	const resultGroups = await Promise.all(
		chunks.map(
			async (chunk) =>
				new Promise<Array<IndexedWorkerResult<TResult>>>((resolve, reject) => {
					const worker = createWorker(new URL(options.moduleUrl), options.createWorkerData(chunk));
					worker.once('message', (message) => {
						resolve(message.results);
					});
					worker.once('error', reject);
					worker.once('exit', (code) => {
						if (code !== 0) {
							reject(new Error(options.errorMessage.replace('{code}', String(code))));
						}
					});
				}),
		),
	);

	const orderedResults = createResultSlots<TResult>(options.items.length);
	for (const results of resultGroups) {
		for (const { index, result } of results) {
			orderedResults[index] = result;
		}
	}
	return orderedResults;
}

if (import.meta.vitest != null) {
	describe('getFileWorkerThreadCount', () => {
		it('disables workers outside bundled runtime', () => {
			expect(
				getFileWorkerThreadCount({
					itemCount: 100,
					isMainThread: true,
					moduleUrl: 'file:///repo/src/data-loader.ts',
				}),
			).toBe(0);
		});

		it('honors explicit worker count', () => {
			expect(
				getFileWorkerThreadCount({
					itemCount: 100,
					isMainThread: true,
					moduleUrl: 'file:///repo/dist/data-loader.js',
					envValue: '4',
				}),
			).toBe(4);
		});
	});

	describe('chunkIndexedItemsByFileSize', () => {
		it('returns no chunks for non-positive chunk counts', async () => {
			await expect(
				chunkIndexedItemsByFileSize([{ index: 0, item: '/missing.jsonl' }], 0, (item) => item),
			).resolves.toEqual([]);
		});
	});

	describe('collectIndexedFileWorkerResults', () => {
		it('orders worker results by original file index across balanced chunks', async () => {
			const workers: Array<{ data: { items: Array<IndexedWorkerItem<string>> } }> = [];
			await using fixture = await createFixture({
				'a.jsonl': 'a',
				'b.jsonl': 'bbbb',
				'c.jsonl': 'cc',
			});

			const results = await collectIndexedFileWorkerResults({
				items: [fixture.getPath('a.jsonl'), fixture.getPath('b.jsonl'), fixture.getPath('c.jsonl')],
				workerCount: 2,
				moduleUrl: 'file:///repo/dist/worker.js',
				errorMessage: 'test worker failed',
				createWorkerData: (items) => ({ items }),
				createWorker: (_moduleUrl, workerData) => {
					const data = workerData as { items: Array<IndexedWorkerItem<string>> };
					workers.push({ data });
					return {
						once(event, listener) {
							if (event === 'message') {
								queueMicrotask(() => {
									const onMessage = listener as (message: {
										results: Array<IndexedWorkerResult<string>>;
									}) => void;
									onMessage({
										results: data.items.map(({ index, item }) => ({
											index,
											result: path.basename(item),
										})),
									});
								});
							}
							return this;
						},
					} satisfies FileWorkerLike<string>;
				},
			});

			expect(workers).toHaveLength(2);
			expect(results).toEqual(['a.jsonl', 'b.jsonl', 'c.jsonl']);
		});
	});
}
