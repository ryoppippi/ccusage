import type { ModelPricing, TokenUsageDelta } from './_types.ts';
import { MILLION } from './_consts.ts';

export function createEmptyUsage(): TokenUsageDelta {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};
}

export function addUsage(target: TokenUsageDelta, delta: TokenUsageDelta): void {
	target.inputTokens += delta.inputTokens;
	target.cachedInputTokens += delta.cachedInputTokens;
	target.outputTokens += delta.outputTokens;
	target.reasoningOutputTokens += delta.reasoningOutputTokens;
	target.totalTokens += delta.totalTokens;
}

function nonCachedInputTokens(usage: TokenUsageDelta): number {
	const nonCached = usage.inputTokens - usage.cachedInputTokens;
	return nonCached > 0 ? nonCached : 0;
}

export function calculateCostUSD(usage: TokenUsageDelta, pricing: ModelPricing): number {
	const nonCachedInput = nonCachedInputTokens(usage);
	const cachedInput = usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens;
	const outputTokens = usage.outputTokens + usage.reasoningOutputTokens;

	const inputCost = (nonCachedInput / MILLION) * pricing.inputCostPerMToken;
	const cachedCost = (cachedInput / MILLION) * pricing.cachedInputCostPerMToken;
	const outputCost = (outputTokens / MILLION) * pricing.outputCostPerMToken;

	return inputCost + cachedCost + outputCost;
}

export function formatTokens(value: number): string {
	return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function formatCurrency(value: number, locale?: string): string {
	return new Intl.NumberFormat(locale ?? 'en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 4,
		maximumFractionDigits: 4,
	}).format(value);
}
