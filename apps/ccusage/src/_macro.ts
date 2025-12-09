import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

function isClaudeModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return modelName.startsWith('claude-')
		|| modelName.startsWith('anthropic.claude-')
		|| modelName.startsWith('anthropic/claude-');
}

export async function prefetchClaudePricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isClaudeModel);
	}
	catch (error) {
		console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
