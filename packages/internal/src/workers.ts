import { stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';

export type IndexedWorkerItem<T> = {
	index: number;
	item: T;
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
}
