import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { prefetchGLMPricing } from './_glm-macro.ts' with { type: 'macro' };
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CCUSAGE_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openrouter/openai/',
	'deepinfra/',
	'vercel_ai_gateway/',
];

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();
const PREFETCHED_GLM_PRICING = prefetchGLMPricing();

async function combinePricingData(): Promise<Record<string, LiteLLMModelPricing>> {
	const [claudePricing, glmPricing] = await Promise.all([
		PREFETCHED_CLAUDE_PRICING,
		PREFETCHED_GLM_PRICING,
	]);

	return {
		...claudePricing,
		...glmPricing,
	};
}

export class PricingFetcher extends LiteLLMPricingFetcher {
	constructor(offline = false) {
		super({
			offline,
			offlineLoader: async () => combinePricingData(),
			logger,
			providerPrefixes: CCUSAGE_PROVIDER_PREFIXES,
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
			}, pricing);

			expect(cost).toBeGreaterThan(0);
		});

		it.each([
			'glm-4.5',
			'deepinfra/zai-org/GLM-4.5',
			'glm-4.5-air',
		])('calculates cost for %s model tokens', async (modelName) => {
			using fetcher = new PricingFetcher(true);
			const pricing = await Result.unwrap(fetcher.getModelPricing(modelName));
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing);

			expect(cost).toBeGreaterThan(0);
		});
	});
}
