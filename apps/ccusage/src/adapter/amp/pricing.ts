import type { LiteLLMModelPricing, LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { AmpUsageEvent } from './schema.ts';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';
import { prefetchAmpPricing } from './pricing-macro.ts' with { type: 'macro' };

export const AMP_PROVIDER_PREFIXES = ['anthropic/', 'anthropic.', 'us.anthropic.', 'eu.anthropic.'];
const PREFETCHED_AMP_PRICING = prefetchAmpPricing();

export async function loadOfflineAmpPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	return PREFETCHED_AMP_PRICING;
}

export async function calculateAmpCost(
	fetcher: LiteLLMPricingFetcher,
	event: AmpUsageEvent,
): Promise<number> {
	const pricing = await fetcher.getModelPricing(event.model);
	if (Result.isFailure(pricing) || pricing.value == null) {
		if (Result.isFailure(pricing)) {
			logger.warn(`Failed to load pricing for model ${event.model}:`, pricing.error);
		}
		return 0;
	}

	return fetcher.calculateCostFromPricing(
		{
			input_tokens: event.inputTokens,
			output_tokens: event.outputTokens,
			cache_creation_input_tokens: event.cacheCreationInputTokens,
			cache_read_input_tokens: event.cacheReadInputTokens,
		},
		pricing.value,
	);
}
