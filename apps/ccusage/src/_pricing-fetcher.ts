import type { PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CLAUDE_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openrouter/openai/',
];

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();

/**
 * Determines whether to use models.dev based on pricing source setting
 * @param pricingSource - The pricing source mode ('auto', 'litellm', or 'modelsdev')
 * @param offline - Whether offline mode is enabled
 * @returns true if models.dev should be used, false otherwise
 */
function shouldUseModelsDev(pricingSource: PricingSource, offline: boolean): boolean {
	if (offline) {
		return false; // Never use models.dev in offline mode
	}

	switch (pricingSource) {
		case 'auto':
			return true; // Use both sources (merged)
		case 'litellm':
			return false; // LiteLLM only
		case 'modelsdev':
			return true; // models.dev only (will be handled by fetcher options)
		default:
			return true; // Default to auto
	}
}

export class PricingFetcher extends LiteLLMPricingFetcher {
	constructor(offline = false, pricingSource: PricingSource = 'auto') {
		// For 'modelsdev' mode, we still need LiteLLM fetcher but only use models.dev data
		// This is handled by the useModelsDev flag and the fetcher will merge appropriately
		const useModelsDev = shouldUseModelsDev(pricingSource, offline);

		super({
			offline,
			offlineLoader: async () => PREFETCHED_CLAUDE_PRICING,
			logger,
			providerPrefixes: CLAUDE_PROVIDER_PREFIXES,
			useModelsDev,
		});
	}
}

if (import.meta.vitest != null) {
	describe('PricingFetcher', () => {
		it('loads offline pricing when offline flag is true', async () => {
			using fetcher = new PricingFetcher(true);
			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBeGreaterThan(0);
		});

		it('calculates cost for Claude model tokens', async () => {
			using fetcher = new PricingFetcher(true);
			const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-20250514'));
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost).toBeGreaterThan(0);
		});
	});
}
