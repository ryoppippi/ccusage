import { sort } from 'fast-sort';

export type UsageGroup = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export function splitUsageTokens(usage: UsageGroup): {
	inputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = usage.outputTokens;
	const reasoningTokens = usage.reasoningOutputTokens;

	return {
		inputTokens,
		reasoningTokens,
		cacheReadTokens,
		outputTokens,
	};
}

export function isOptionExplicit(tokens: ReadonlyArray<unknown>, optionName: string): boolean {
	for (const token of tokens) {
		if (typeof token === 'object' && token != null) {
			const candidate = token as { kind?: string; name?: string };
			if (candidate.kind === 'option' && candidate.name === optionName) {
				return true;
			}
		}
	}
	return false;
}

export function formatModelsList(models: Record<string, { totalTokens: number }>): string[] {
	return sort(Object.keys(models))
		.asc(model => model);
}
