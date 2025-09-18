import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import process from 'node:process';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

function isClaudeModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return modelName.startsWith('claude-');
}

export async function prefetchClaudePricing(): Promise<Record<string, LiteLLMModelPricing>> {
	if (process.env.OFFLINE === 'true') {
		return createPricingDataset();
	}

	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isClaudeModel);
	}
	catch (error) {
		console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
