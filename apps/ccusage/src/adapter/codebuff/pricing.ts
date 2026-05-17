import type { LiteLLMModelPricing, LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { CodebuffUsageEntry } from './parser.ts';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

export const CODEBUFF_PROVIDER_PREFIXES = [
	'anthropic/',
	'anthropic.',
	'openai/',
	'google/',
	'xai/',
	'openrouter/',
] as const;
export async function loadOfflineCodebuffPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	return {};
}

function getPricingCandidates(entry: CodebuffUsageEntry): string[] {
	const candidates = new Set<string>([entry.model]);
	if (entry.provider !== 'unknown' && !entry.model.startsWith(`${entry.provider}/`)) {
		candidates.add(`${entry.provider}/${entry.model}`);
	}
	return Array.from(candidates);
}

export async function calculateCodebuffCost(
	fetcher: LiteLLMPricingFetcher,
	entry: CodebuffUsageEntry,
): Promise<number> {
	for (const model of getPricingCandidates(entry)) {
		const pricing = await fetcher.getModelPricing(model);
		if (Result.isFailure(pricing)) {
			logger.warn(`Failed to load pricing for model ${model}:`, pricing.error);
			continue;
		}
		if (pricing.value == null) {
			continue;
		}
		return fetcher.calculateCostFromPricing(
			{
				input_tokens: entry.inputTokens,
				output_tokens: entry.outputTokens,
				cache_creation_input_tokens: entry.cacheCreationInputTokens,
				cache_read_input_tokens: entry.cacheReadInputTokens,
			},
			pricing.value,
		);
	}
	return 0;
}
