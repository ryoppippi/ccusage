import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { groupBy } from 'es-toolkit';
import { calculateCostForEntry } from './cost-utils.ts';

export type DailyReportRow = {
	date: string; // YYYY-MM-DD
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

export type DailyReportOptions = {
	pricingFetcher: LiteLLMPricingFetcher;
};

export async function buildDailyReport(
	entries: LoadedUsageEntry[],
	options: DailyReportOptions,
): Promise<DailyReportRow[]> {
	const entriesByDate = groupBy(entries, (entry) => entry.timestamp.toISOString().split('T')[0]!);

	const dailyData: DailyReportRow[] = [];

	for (const [date, dayEntries] of Object.entries(entriesByDate)) {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		let totalCost = 0;
		const modelsSet = new Set<string>();

		for (const entry of dayEntries) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
			cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			cacheReadTokens += entry.usage.cacheReadInputTokens;
			totalCost += await calculateCostForEntry(entry, options.pricingFetcher);
			modelsSet.add(entry.model);
		}

		const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

		dailyData.push({
			date,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			totalTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
		});
	}

	dailyData.sort((a, b) => a.date.localeCompare(b.date));

	return dailyData;
}
