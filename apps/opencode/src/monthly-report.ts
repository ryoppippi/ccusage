import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { groupBy } from 'es-toolkit';
import { calculateCostForEntry } from './cost-utils.ts';

export type MonthlyReportRow = {
	month: string; // YYYY-MM
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

export type MonthlyReportOptions = {
	pricingFetcher: LiteLLMPricingFetcher;
};

export async function buildMonthlyReport(
	entries: LoadedUsageEntry[],
	options: MonthlyReportOptions,
): Promise<MonthlyReportRow[]> {
	const entriesByMonth = groupBy(entries, (entry) => entry.timestamp.toISOString().slice(0, 7));

	const monthlyData: MonthlyReportRow[] = [];

	for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		let totalCost = 0;
		const modelsSet = new Set<string>();

		for (const entry of monthEntries) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
			cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			cacheReadTokens += entry.usage.cacheReadInputTokens;
			totalCost += await calculateCostForEntry(entry, options.pricingFetcher);
			modelsSet.add(entry.model);
		}

		const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

		monthlyData.push({
			month,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			totalTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
		});
	}

	monthlyData.sort((a, b) => a.month.localeCompare(b.month));

	return monthlyData;
}
