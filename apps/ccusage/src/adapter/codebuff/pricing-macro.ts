import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

const CODEBUFF_MODEL_PREFIXES = [
	'claude-',
	'anthropic/',
	'anthropic.',
	'gpt-',
	'openai/',
	'gemini',
	'google/',
	'grok',
	'xai/',
	'openrouter/',
] as const;

function isCodebuffModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return CODEBUFF_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

export async function prefetchCodebuffPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	const result = await Result.try({
		try: fetchLiteLLMPricingDataset(),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		logger.warn('Failed to prefetch Codebuff pricing data, proceeding with empty cache.');
		logger.debug('Codebuff pricing prefetch error:', result.error);
		return createPricingDataset();
	}

	return filterPricingDataset(result.value, isCodebuffModel);
}
