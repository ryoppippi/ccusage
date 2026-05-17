import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

function isDroidProviderModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return (
		modelName.startsWith('claude-') ||
		modelName.startsWith('anthropic/') ||
		modelName.startsWith('openrouter/anthropic/') ||
		modelName.startsWith('gpt-') ||
		modelName.startsWith('openai/') ||
		modelName.startsWith('openrouter/openai/') ||
		modelName.startsWith('gemini-') ||
		modelName.startsWith('google/') ||
		modelName.startsWith('vertex_ai/') ||
		modelName.startsWith('openrouter/google/') ||
		modelName.startsWith('grok-') ||
		modelName.startsWith('xai/') ||
		modelName.startsWith('openrouter/x-ai/')
	);
}

export async function prefetchDroidPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	const result = await Result.try({
		try: fetchLiteLLMPricingDataset(),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		logger.warn('Failed to prefetch Droid pricing data, proceeding with empty cache.');
		logger.debug('Droid pricing prefetch error:', result.error);
		return createPricingDataset();
	}

	return filterPricingDataset(result.value, isDroidProviderModel);
}
