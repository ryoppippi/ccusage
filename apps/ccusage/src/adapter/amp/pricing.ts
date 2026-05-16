import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { AmpUsageEvent } from './schema.ts';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

export const AMP_PROVIDER_PREFIXES = ['anthropic/', 'anthropic.', 'us.anthropic.', 'eu.anthropic.'];

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
