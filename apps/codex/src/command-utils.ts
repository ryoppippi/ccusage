import { sort } from 'fast-sort';

export type UsageGroup = {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cachedInputTokens?: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export function splitUsageTokens(usage: UsageGroup): {
	inputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens =
		usage.cacheReadTokens ?? Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = Math.max(usage.outputTokens, 0);
	const rawReasoning = usage.reasoningOutputTokens ?? 0;
	const reasoningTokens = Math.max(0, Math.min(rawReasoning, outputTokens));

	return {
		inputTokens,
		reasoningTokens,
		cacheReadTokens,
		outputTokens,
	};
}

export function formatModelsList(
	models: Record<string, { totalTokens: number; isFallback?: boolean }>,
): string[] {
	return sort(Object.entries(models))
		.asc(([model]) => model)
		.map(([model, data]) => (data.isFallback === true ? `${model} (fallback)` : model));
}
