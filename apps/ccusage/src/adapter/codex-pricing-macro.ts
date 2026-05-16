import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

function isCodexModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return (
		modelName.startsWith('gpt-') ||
		modelName.startsWith('openai/') ||
		modelName.startsWith('azure/') ||
		modelName.startsWith('openrouter/openai/')
	);
}

export async function prefetchCodexPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isCodexModel);
	} catch (error) {
		console.warn('Failed to prefetch Codex pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
