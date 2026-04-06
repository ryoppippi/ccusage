import type { ModelPricing, TokenUsageDelta } from './_types.ts';
import { formatCurrency, formatTokens } from '@ccusage/internal/format';
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

function calculateTieredCost(
	totalTokens: number,
	basePricePerMToken: number,
	tieredPricePerMToken?: number,
	thresholdTokens?: number,
): number {
	if (totalTokens <= 0) {
		return 0;
	}

	if (thresholdTokens == null || tieredPricePerMToken == null || totalTokens <= thresholdTokens) {
		return (totalTokens / MILLION) * basePricePerMToken;
	}

	const tokensBelowThreshold = Math.min(totalTokens, thresholdTokens);
	const tokensAboveThreshold = Math.max(0, totalTokens - thresholdTokens);

	return (
		(tokensBelowThreshold / MILLION) * basePricePerMToken +
		(tokensAboveThreshold / MILLION) * tieredPricePerMToken
	);
}

/**
 * Calculate the cost in USD for token usage based on model pricing
 *
 * @param usage - Token usage data including input, output, cached, and reasoning tokens
 * @param pricing - Model-specific pricing rates per million tokens
 * @returns Cost in USD
 *
 * @remarks
 * - Cached input tokens receive a 50% discount from OpenAI
 * @see {@link https://platform.openai.com/docs/guides/prompt-caching}
 *
 * - Reasoning tokens are already included in output_tokens, so they are not added separately
 * to avoid double-counting
 */
export function calculateCostUSD(usage: TokenUsageDelta, pricing: ModelPricing): number {
	const nonCachedInput = nonCachedInputTokens(usage);
	const cachedInput =
		usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens;
	const outputTokens = usage.outputTokens;

	const inputCost = calculateTieredCost(
		nonCachedInput,
		pricing.inputCostPerMToken,
		pricing.inputCostPerMTokenAboveThreshold,
		pricing.tieredThresholdTokens,
	);
	const cachedCost = calculateTieredCost(
		cachedInput,
		pricing.cachedInputCostPerMToken,
		pricing.cachedInputCostPerMTokenAboveThreshold,
		pricing.tieredThresholdTokens,
	);
	const outputCost = calculateTieredCost(
		outputTokens,
		pricing.outputCostPerMToken,
		pricing.outputCostPerMTokenAboveThreshold,
		pricing.tieredThresholdTokens,
	);

	return inputCost + cachedCost + outputCost;
}

export { formatCurrency, formatTokens };

if (import.meta.vitest != null) {
	describe('calculateCostUSD', () => {
		it('uses flat pricing when no tiered rates are provided', () => {
			const cost = calculateCostUSD(
				{
					inputTokens: 1_000,
					cachedInputTokens: 100,
					outputTokens: 500,
					reasoningOutputTokens: 0,
					totalTokens: 1_500,
				},
				{
					inputCostPerMToken: 2.5,
					cachedInputCostPerMToken: 0.25,
					outputCostPerMToken: 15,
				},
			);

			const expected = (900 / MILLION) * 2.5 + (100 / MILLION) * 0.25 + (500 / MILLION) * 15;
			expect(cost).toBeCloseTo(expected, 10);
		});

		it('uses tiered pricing above the configured threshold', () => {
			const cost = calculateCostUSD(
				{
					inputTokens: 320_000,
					cachedInputTokens: 40_000,
					outputTokens: 300_000,
					reasoningOutputTokens: 0,
					totalTokens: 620_000,
				},
				{
					inputCostPerMToken: 2.5,
					cachedInputCostPerMToken: 0.25,
					outputCostPerMToken: 15,
					tieredThresholdTokens: 272_000,
					inputCostPerMTokenAboveThreshold: 5,
					cachedInputCostPerMTokenAboveThreshold: 0.5,
					outputCostPerMTokenAboveThreshold: 22.5,
				},
			);

			const expected =
				(272_000 / MILLION) * 2.5 +
				(8_000 / MILLION) * 5 +
				(40_000 / MILLION) * 0.25 +
				(272_000 / MILLION) * 15 +
				(28_000 / MILLION) * 22.5;
			expect(cost).toBeCloseTo(expected, 10);
		});
	});
}
