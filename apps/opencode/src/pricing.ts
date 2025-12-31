import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource, TokenUsageDelta } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { logger } from './logger.ts';

const OPENCODE_PROVIDER_PREFIXES = [
	'anthropic/',
	'openai/',
	'azure/',
	'google/',
	'openrouter/',
	'moonshotai/',
];

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

export type OpenCodePricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

export class OpenCodePricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;

	constructor(options: OpenCodePricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			offlineLoader: options.offlineLoader,
			logger,
			providerPrefixes: OPENCODE_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	async getPricing(model: string): Promise<ModelPricing | null> {
		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			logger.debug(`Failed to get pricing for model ${model}:`, directLookup.error);
			return null;
		}

		const pricing = directLookup.value;
		if (pricing == null) {
			logger.debug(`No pricing found for model ${model}`);
			return null;
		}

		return {
			inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
			outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
			cacheReadCostPerMToken: toPerMillion(pricing.cache_read_input_token_cost, pricing.input_cost_per_token),
			cacheWriteCostPerMToken: toPerMillion(pricing.cache_creation_input_token_cost, pricing.input_cost_per_token),
		};
	}
}

export function calculateCostUSD(usage: TokenUsageDelta, pricing: ModelPricing): number {
	const inputCost = (usage.inputTokens / MILLION) * pricing.inputCostPerMToken;
	const outputCost = (usage.outputTokens / MILLION) * pricing.outputCostPerMToken;
	const cacheReadCost = (usage.cacheReadTokens / MILLION) * pricing.cacheReadCostPerMToken;
	const cacheWriteCost = (usage.cacheWriteTokens / MILLION) * pricing.cacheWriteCostPerMToken;

	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

if (import.meta.vitest != null) {
	describe('OpenCodePricingSource', () => {
		it('converts LiteLLM pricing to per-million costs', async () => {
			using source = new OpenCodePricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-sonnet-4-20250514': {
						input_cost_per_token: 3e-6,
						output_cost_per_token: 1.5e-5,
						cache_read_input_token_cost: 3e-7,
						cache_creation_input_token_cost: 3.75e-6,
					},
				}),
			});

			const pricing = await source.getPricing('claude-sonnet-4-20250514');
			expect(pricing).not.toBeNull();
			expect(pricing!.inputCostPerMToken).toBeCloseTo(3);
			expect(pricing!.outputCostPerMToken).toBeCloseTo(15);
			expect(pricing!.cacheReadCostPerMToken).toBeCloseTo(0.3);
			expect(pricing!.cacheWriteCostPerMToken).toBeCloseTo(3.75);
		});

		it('returns null for unknown models', async () => {
			using source = new OpenCodePricingSource({
				offline: true,
				offlineLoader: async () => ({}),
			});

			const pricing = await source.getPricing('unknown-model');
			expect(pricing).toBeNull();
		});
	});

	describe('calculateCostUSD', () => {
		it('calculates cost from token usage', () => {
			const usage: TokenUsageDelta = {
				inputTokens: 1_000_000,
				outputTokens: 500_000,
				reasoningTokens: 0,
				cacheReadTokens: 200_000,
				cacheWriteTokens: 100_000,
				totalTokens: 1_800_000,
			};

			const pricing: ModelPricing = {
				inputCostPerMToken: 3,
				outputCostPerMToken: 15,
				cacheReadCostPerMToken: 0.3,
				cacheWriteCostPerMToken: 3.75,
			};

			const cost = calculateCostUSD(usage, pricing);
			const expected = 3 + 7.5 + 0.06 + 0.375;
			expect(cost).toBeCloseTo(expected);
		});
	});
}
