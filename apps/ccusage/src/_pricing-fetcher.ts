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

export class PricingFetcher extends LiteLLMPricingFetcher {
	constructor(offline = false) {
		super({
			offline,
			offlineLoader: async () => PREFETCHED_CLAUDE_PRICING,
			logger,
			providerPrefixes: CLAUDE_PROVIDER_PREFIXES,
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
			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
					cache_read_input_tokens: 300,
				},
				pricing!,
			);

			expect(cost).toBeGreaterThan(0);
		});
	});
}
