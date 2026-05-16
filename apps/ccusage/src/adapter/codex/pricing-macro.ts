import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

function isCodexModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return (
		modelName.startsWith('gpt-') ||
		modelName.startsWith('openai/') ||
		modelName.startsWith('azure/') ||
		modelName.startsWith('openrouter/openai/')
	);
}

export async function prefetchCodexPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	const result = await Result.try({
		try: fetchLiteLLMPricingDataset(),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		logger.warn('Failed to prefetch Codex pricing data, proceeding with empty cache.');
		logger.debug('Codex pricing prefetch error:', result.error);
		return createPricingDataset();
	}

	return filterPricingDataset(result.value, isCodexModel);
}
