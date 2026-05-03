import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { calculateCostForEntry } from './cost-utils.ts';
import type { LoadedUsageEntry } from './data-loader.ts';

export const TABLE_COLUMN_COUNT = 8;

export type AggregatedRow = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

/**
 * Aggregate token usage and cost for a group of entries.
 */
export async function aggregateGroup(
	entries: LoadedUsageEntry[],
	fetcher: LiteLLMPricingFetcher,
): Promise<AggregatedRow> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	let totalCost = 0;
	const modelsSet = new Set<string>();

	for (const entry of entries) {
		inputTokens += entry.usage.inputTokens;
		outputTokens += entry.usage.outputTokens;
		cacheCreationTokens += entry.usage.cacheCreationInputTokens;
		cacheReadTokens += entry.usage.cacheReadInputTokens;
		totalCost += await calculateCostForEntry(entry, fetcher);
		modelsSet.add(entry.model);
	}

	return {
		inputTokens,
		outputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
		totalCost,
		modelsUsed: Array.from(modelsSet),
	};
}

export type Totals = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
};

/**
 * Compute totals from an array of aggregated rows.
 */
export function computeTotals(rows: Array<Pick<AggregatedRow, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'totalTokens' | 'totalCost'>>): Totals {
	return {
		inputTokens: rows.reduce((sum, d) => sum + d.inputTokens, 0),
		outputTokens: rows.reduce((sum, d) => sum + d.outputTokens, 0),
		cacheCreationTokens: rows.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
		cacheReadTokens: rows.reduce((sum, d) => sum + d.cacheReadTokens, 0),
		totalTokens: rows.reduce((sum, d) => sum + d.totalTokens, 0),
		totalCost: rows.reduce((sum, d) => sum + d.totalCost, 0),
	};
}
