import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

const AMP_MODEL_PREFIXES = [
	'claude-',
	'anthropic/',
	'anthropic.',
	'us.anthropic.',
	'eu.anthropic.',
];

function isAmpModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return AMP_MODEL_PREFIXES.some((prefix) => modelName.startsWith(prefix));
}

export async function prefetchAmpPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	const result = await Result.try({
		try: fetchLiteLLMPricingDataset(),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		logger.warn('Failed to prefetch Amp pricing data, proceeding with empty cache.');
		logger.debug('Amp pricing prefetch error:', result.error);
		return createPricingDataset();
	}

	return filterPricingDataset(result.value, isAmpModel);
}
