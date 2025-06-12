import type { ModelBreakdown, UsageData } from './data-loader.ts';

export type TokenStats = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

/**
 * Aggregates token counts and costs by model name
 */
export function aggregateByModel<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): Map<string, TokenStats> {
	const modelAggregates = new Map<string, TokenStats>();

	for (const entry of entries) {
		const modelName = getModel(entry) ?? 'unknown';
		// Skip synthetic model
		if (modelName === '<synthetic>') {
			continue;
		}

		const usage = getUsage(entry);
		const cost = getCost(entry);

		const existing = modelAggregates.get(modelName) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
		};

		modelAggregates.set(modelName, {
			inputTokens: existing.inputTokens + (usage.input_tokens ?? 0),
			outputTokens: existing.outputTokens + (usage.output_tokens ?? 0),
			cacheCreationTokens: existing.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
			cacheReadTokens: existing.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
			cost: existing.cost + cost,
		});
	}

	return modelAggregates;
}

/**
 * Aggregates model breakdowns from multiple sources
 */
export function aggregateModelBreakdowns(
	breakdowns: ModelBreakdown[],
): Map<string, TokenStats> {
	const modelAggregates = new Map<string, TokenStats>();

	for (const breakdown of breakdowns) {
		// Skip synthetic model
		if (breakdown.modelName === '<synthetic>') {
			continue;
		}

		const existing = modelAggregates.get(breakdown.modelName) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
		};

		modelAggregates.set(breakdown.modelName, {
			inputTokens: existing.inputTokens + breakdown.inputTokens,
			outputTokens: existing.outputTokens + breakdown.outputTokens,
			cacheCreationTokens: existing.cacheCreationTokens + breakdown.cacheCreationTokens,
			cacheReadTokens: existing.cacheReadTokens + breakdown.cacheReadTokens,
			cost: existing.cost + breakdown.cost,
		});
	}

	return modelAggregates;
}

/**
 * Converts model aggregates to sorted model breakdowns
 */
export function createModelBreakdowns(
	modelAggregates: Map<string, TokenStats>,
): ModelBreakdown[] {
	return Array.from(modelAggregates.entries())
		.map(([modelName, stats]) => ({
			modelName,
			...stats,
		}))
		.sort((a, b) => b.cost - a.cost); // Sort by cost descending
}

/**
 * Calculates total token counts and costs from entries
 */
export function calculateTotals<T>(
	entries: T[],
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): TokenStats & { totalCost: number } {
	return entries.reduce(
		(acc, entry) => {
			const usage = getUsage(entry);
			const cost = getCost(entry);

			return {
				inputTokens: acc.inputTokens + (usage.input_tokens ?? 0),
				outputTokens: acc.outputTokens + (usage.output_tokens ?? 0),
				cacheCreationTokens: acc.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
				cacheReadTokens: acc.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
				cost: acc.cost + cost,
				totalCost: acc.totalCost + cost,
			};
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
			totalCost: 0,
		},
	);
}

/**
 * Filters items by date range
 */
export function filterByDateRange<T>(
	items: T[],
	getDate: (item: T) => string,
	since?: string,
	until?: string,
): T[] {
	if (since == null && until == null) {
		return items;
	}

	return items.filter((item) => {
		const dateStr = getDate(item).replace(/-/g, ''); // Convert to YYYYMMDD
		if (since != null && dateStr < since) {
			return false;
		}
		if (until != null && dateStr > until) {
			return false;
		}
		return true;
	});
}

/**
 * Checks if an entry is a duplicate based on hash
 */
export function isDuplicateEntry(
	uniqueHash: string | null,
	processedHashes: Set<string>,
): boolean {
	if (uniqueHash == null) {
		return false;
	}
	return processedHashes.has(uniqueHash);
}

/**
 * Marks an entry as processed
 */
export function markAsProcessed(
	uniqueHash: string | null,
	processedHashes: Set<string>,
): void {
	if (uniqueHash != null) {
		processedHashes.add(uniqueHash);
	}
}

/**
 * Extracts unique models from entries, excluding synthetic model
 */
export function extractUniqueModels<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
): string[] {
	return [...new Set(entries.map(getModel).filter((m): m is string => m != null && m !== '<synthetic>'))];
}
