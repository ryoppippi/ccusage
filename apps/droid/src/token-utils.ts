import type { ModelUsage } from './_types.ts';

function ensureNonNegativeNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function toTotalTokens(usage: {
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}): number {
	return (
		usage.inputTokens +
		usage.outputTokens +
		usage.thinkingTokens +
		usage.cacheReadTokens +
		usage.cacheCreationTokens
	);
}

export function createEmptyUsage(): ModelUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		thinkingTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		totalTokens: 0,
	};
}

export function normalizeUsage(value: unknown): Omit<ModelUsage, 'totalTokens'> {
	if (value == null || typeof value !== 'object') {
		return {
			inputTokens: 0,
			outputTokens: 0,
			thinkingTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
	}

	const record = value as Record<string, unknown>;
	return {
		inputTokens: ensureNonNegativeNumber(record.inputTokens),
		outputTokens: ensureNonNegativeNumber(record.outputTokens),
		thinkingTokens: ensureNonNegativeNumber(record.thinkingTokens),
		cacheReadTokens: ensureNonNegativeNumber(record.cacheReadTokens),
		cacheCreationTokens: ensureNonNegativeNumber(record.cacheCreationTokens),
	};
}

export function addUsage(target: ModelUsage, add: Omit<ModelUsage, 'totalTokens'>): void {
	target.inputTokens += add.inputTokens;
	target.outputTokens += add.outputTokens;
	target.thinkingTokens += add.thinkingTokens;
	target.cacheReadTokens += add.cacheReadTokens;
	target.cacheCreationTokens += add.cacheCreationTokens;
	target.totalTokens = toTotalTokens(target);
}

export function subtractUsage(
	current: Omit<ModelUsage, 'totalTokens'>,
	previous: ModelUsage,
): ModelUsage {
	const inputTokens = current.inputTokens - previous.inputTokens;
	const outputTokens = current.outputTokens - previous.outputTokens;
	const thinkingTokens = current.thinkingTokens - previous.thinkingTokens;
	const cacheReadTokens = current.cacheReadTokens - previous.cacheReadTokens;
	const cacheCreationTokens = current.cacheCreationTokens - previous.cacheCreationTokens;

	const isReset =
		inputTokens < 0 ||
		outputTokens < 0 ||
		thinkingTokens < 0 ||
		cacheReadTokens < 0 ||
		cacheCreationTokens < 0;

	if (isReset) {
		return {
			inputTokens: current.inputTokens,
			outputTokens: current.outputTokens,
			thinkingTokens: current.thinkingTokens,
			cacheReadTokens: current.cacheReadTokens,
			cacheCreationTokens: current.cacheCreationTokens,
			totalTokens: toTotalTokens(current),
		};
	}

	const delta = {
		inputTokens,
		outputTokens,
		thinkingTokens,
		cacheReadTokens,
		cacheCreationTokens,
	};

	return {
		...delta,
		totalTokens: toTotalTokens(delta),
	};
}

if (import.meta.vitest != null) {
	describe('subtractUsage', () => {
		it('computes deltas', () => {
			const delta = subtractUsage(
				{
					inputTokens: 15,
					outputTokens: 7,
					thinkingTokens: 2,
					cacheReadTokens: 130,
					cacheCreationTokens: 4,
				},
				{
					inputTokens: 10,
					outputTokens: 5,
					thinkingTokens: 2,
					cacheReadTokens: 100,
					cacheCreationTokens: 3,
					totalTokens: 0,
				},
			);

			expect(delta.inputTokens).toBe(5);
			expect(delta.cacheReadTokens).toBe(30);
			expect(delta.totalTokens).toBe(5 + 2 + 0 + 30 + 1);
		});

		it('treats negative deltas as reset', () => {
			const delta = subtractUsage(
				{
					inputTokens: 20,
					outputTokens: 10,
					thinkingTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
				},
				{
					inputTokens: 100,
					outputTokens: 50,
					thinkingTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					totalTokens: 0,
				},
			);

			expect(delta.inputTokens).toBe(20);
			expect(delta.totalTokens).toBe(30);
		});
	});
}
