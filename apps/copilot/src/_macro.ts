import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

const COPILOT_MODEL_PREFIXES = ['claude-', 'anthropic/', 'gpt-', 'openai/'];

function isCopilotModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return COPILOT_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

export async function prefetchCopilotPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isCopilotModel);
	} catch (error) {
		console.warn('Failed to prefetch Copilot pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
