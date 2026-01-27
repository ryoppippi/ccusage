/**
 * @fileoverview Token-usage helpers for Factory Droid reports.
 *
 * Factory logs expose cumulative token counters; these utilities normalize raw values,
 * compute deltas, and keep totals consistent.
 */

import type { ModelUsage } from './_types.ts';

/**
 * Coerces unknown values into a non-negative finite number.
 */
function ensureNonNegativeNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Computes `totalTokens` for a usage record.
 */
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

/**
 * Creates an empty, zeroed token usage structure.
 */
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

/**
 * Normalizes an unknown token usage payload into a numeric token usage structure.
 *
 * Missing/invalid values are treated as `0`.
 */
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

/**
 * Adds token usage values to a mutable target and updates `totalTokens`.
 */
export function addUsage(target: ModelUsage, add: Omit<ModelUsage, 'totalTokens'>): void {
	target.inputTokens += add.inputTokens;
	target.outputTokens += add.outputTokens;
	target.thinkingTokens += add.thinkingTokens;
	target.cacheReadTokens += add.cacheReadTokens;
	target.cacheCreationTokens += add.cacheCreationTokens;
	target.totalTokens = toTotalTokens(target);
}

/**
 * Computes a delta between current cumulative counters and the last known totals.
 *
 * If any counter decreases (reset), returns the current counters as the delta.
 */
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
