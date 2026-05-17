import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

const GEMINI_MODEL_PREFIXES = [
	'gemini-',
	'google/gemini-',
	'gemini/gemini-',
	'vertex_ai/gemini-',
	'openrouter/google/gemini-',
];

function isGeminiModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return GEMINI_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

export async function prefetchGeminiPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	const result = await Result.try({
		try: fetchLiteLLMPricingDataset(),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		logger.warn('Failed to prefetch Gemini pricing data, proceeding with empty cache.');
		logger.debug('Gemini pricing prefetch error:', result.error);
		return createPricingDataset();
	}

	return filterPricingDataset(result.value, isGeminiModel);
}
