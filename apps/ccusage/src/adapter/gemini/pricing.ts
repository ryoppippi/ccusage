import type { LiteLLMModelPricing, LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { GeminiUsageEvent } from './schema.ts';
import { LiteLLMPricingFetcher as PricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { prefetchGeminiPricing } from './pricing-macro.ts' with { type: 'macro' };

export const GEMINI_PROVIDER_PREFIXES = ['google/', 'gemini/', 'vertex_ai/', 'openrouter/google/'];
const PREFETCHED_GEMINI_PRICING = prefetchGeminiPricing();

function calculateTieredCost(
	totalTokens: number,
	basePrice: number | undefined,
	tieredPrices: Array<[threshold: number, price: number | undefined]>,
): number {
	const base = basePrice ?? 0;
	let cost = 0;
	let lowerBound = 0;
	let activePrice = base;
	for (const [threshold, price] of tieredPrices) {
		if (price == null || totalTokens <= lowerBound) {
			continue;
		}
		if (totalTokens <= threshold) {
			return cost + (totalTokens - lowerBound) * activePrice;
		}
		cost += (threshold - lowerBound) * activePrice;
		lowerBound = threshold;
		activePrice = price;
	}
	return cost + Math.max(totalTokens - lowerBound, 0) * activePrice;
}

export async function loadOfflineGeminiPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	return PREFETCHED_GEMINI_PRICING;
}

export async function calculateGeminiCost(
	event: GeminiUsageEvent,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	const pricing = await fetcher.getModelPricing(event.model);
	if (Result.isFailure(pricing) || pricing.value == null) {
		return 0;
	}
	return (
		calculateTieredCost(event.inputTokens, pricing.value.input_cost_per_token, [
			[128_000, pricing.value.input_cost_per_token_above_128k_tokens],
			[200_000, pricing.value.input_cost_per_token_above_200k_tokens],
		]) +
		calculateTieredCost(
			event.outputTokens + event.reasoningTokens,
			pricing.value.output_cost_per_token,
			[
				[128_000, pricing.value.output_cost_per_token_above_128k_tokens],
				[200_000, pricing.value.output_cost_per_token_above_200k_tokens],
			],
		) +
		calculateTieredCost(event.cacheReadTokens, pricing.value.cache_read_input_token_cost, [
			[200_000, pricing.value.cache_read_input_token_cost_above_200k_tokens],
		])
	);
}

if (import.meta.vitest != null) {
	describe('calculateGeminiCost', () => {
		it('prices reasoning tokens as output tokens and uses Gemini 128k tiers', async () => {
			using fetcher = new PricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gemini-2.5-pro': {
						input_cost_per_token: 1,
						input_cost_per_token_above_128k_tokens: 2,
						output_cost_per_token: 10,
						output_cost_per_token_above_128k_tokens: 20,
						cache_read_input_token_cost: 0.1,
					},
				}),
			});

			await expect(
				calculateGeminiCost(
					{
						timestamp: '2026-05-17T00:00:00.000Z',
						sessionId: 'session-a',
						model: 'gemini-2.5-pro',
						inputTokens: 128_001,
						outputTokens: 1,
						cacheReadTokens: 2,
						reasoningTokens: 128_000,
						toolTokens: 0,
						totalTokens: 256_004,
					},
					fetcher,
				),
			).resolves.toBe(1_408_022.2);
		});
	});
}
