import type { LiteLLMModelPricing } from '@better-ccusage/internal/pricing';
import process from 'node:process';
import {
	createPricingDataset,
	loadLocalPricingDataset,
	filterPricingDataset,
} from '@better-ccusage/internal/pricing-fetch-utils';

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
	try {
		// Always use local pricing data
		const dataset = loadLocalPricingDataset();
		return filterPricingDataset(dataset, isCodexModel);
	}
	catch (error) {
		console.warn('Failed to load local Codex pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
