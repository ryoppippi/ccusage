import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

/**
 * Codebuff routes to several upstream providers via OpenRouter, so we retain a
 * generous set of model-name prefixes when prefetching pricing.
 */
const CODEBUFF_MODEL_PREFIXES = [
	'claude-',
	'anthropic/',
	'gpt-',
	'o1',
	'o3',
	'o4',
	'openai/',
	'azure/',
	'gemini-',
	'google/',
	'grok-',
	'xai/',
	'mistral/',
	'mistralai/',
	'deepseek/',
	'qwen/',
	'openrouter/',
];

function isCodebuffModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return CODEBUFF_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

export async function prefetchCodebuffPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isCodebuffModel);
	} catch (error) {
		console.warn('Failed to prefetch Codebuff pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
