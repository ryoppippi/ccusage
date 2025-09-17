import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import process from 'node:process';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

const CODEX_MODEL_PREFIXES = [
	'gpt-5',
	'gpt-5-',
	'openai/gpt-5',
	'azure/gpt-5',
	'openrouter/openai/gpt-5',
];

function isCodexModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return CODEX_MODEL_PREFIXES.some(prefix => modelName.startsWith(prefix));
}

export async function prefetchCodexPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	if (process.env.OFFLINE === 'true') {
		return createPricingDataset();
	}

	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isCodexModel);
	}
	catch (error) {
		console.warn('Failed to prefetch Codex pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
