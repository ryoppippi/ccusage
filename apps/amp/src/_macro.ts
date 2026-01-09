import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

const AMP_MODEL_PREFIXES = [
	'claude-',
	'anthropic/',
];

function isAmpModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return AMP_MODEL_PREFIXES.some(prefix => modelName.startsWith(prefix));
}

export async function prefetchAmpPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isAmpModel);
	}
	catch (error) {
		console.warn('Failed to prefetch Amp pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
