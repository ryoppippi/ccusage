import type { DailyUsage, MonthlyUsage, SessionUsage } from './data-loader.ts';

/**
 * Token usage data structure containing input, output, and cache token counts
 */
type TokenData = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};

/**
 * Token totals including cost information
 */
type TokenTotals = TokenData & {
	totalCost: number;
};

/**
 * Complete totals object with token counts, cost, and total token sum
 */
type TotalsObject = TokenTotals & {
	totalTokens: number;
};

/**
 * Calculates total token usage and cost across multiple usage data entries
 * @param data - Array of daily, monthly, or session usage data
 * @returns Aggregated token totals and cost
 */
export function calculateTotals(
	data: Array<DailyUsage | MonthlyUsage | SessionUsage>,
): TokenTotals {
	return data.reduce(
		(acc, item) => ({
			inputTokens: acc.inputTokens + item.inputTokens,
			outputTokens: acc.outputTokens + item.outputTokens,
			cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
			cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
			totalCost: acc.totalCost + item.totalCost,
		}),
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		},
	);
}

/**
 * Calculates the sum of all token types (input, output, cache creation, cache read)
 * @param tokens - Token data containing different token counts
 * @returns Total number of tokens across all types
 */
export function getTotalTokens(tokens: TokenData): number {
	return (
		tokens.inputTokens
		+ tokens.outputTokens
		+ tokens.cacheCreationTokens
		+ tokens.cacheReadTokens
	);
}

/**
 * Creates a complete totals object by adding total token count to existing totals
 * @param totals - Token totals with cost information
 * @returns Complete totals object including total token sum
 */
export function createTotalsObject(totals: TokenTotals): TotalsObject {
	return {
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheCreationTokens: totals.cacheCreationTokens,
		cacheReadTokens: totals.cacheReadTokens,
		totalTokens: getTotalTokens(totals),
		totalCost: totals.totalCost,
	};
}
