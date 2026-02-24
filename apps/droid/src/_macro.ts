/**
 * @fileoverview Lightweight helper for prefetching Factory model pricing.
 */

import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';
import { logger } from './logger.ts';

const FACTORY_MODEL_PREFIXES = [
	'openai/',
	'azure/',
	'anthropic/',
	'openrouter/',
	'gpt-',
	'claude-',
	'gemini-',
	'google/',
	'vertex_ai/',
];

function isFactoryModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return FACTORY_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

export async function prefetchFactoryPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isFactoryModel);
	} catch (error) {
		logger.warn('Failed to prefetch Factory pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
