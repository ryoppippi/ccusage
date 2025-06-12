import type { DailyUsage, MonthlyUsage, SessionUsage } from './data-loader.ts';

type TokenData = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};

type TokenTotals = TokenData & {
	totalCost: number;
};

type TotalsObject = TokenTotals & {
	totalTokens: number;
};

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

export function getTotalTokens(tokens: TokenData): number {
	return (
		tokens.inputTokens
		+ tokens.outputTokens
		+ tokens.cacheCreationTokens
		+ tokens.cacheReadTokens
	);
}

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
