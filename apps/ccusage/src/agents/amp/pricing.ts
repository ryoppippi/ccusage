import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchAmpPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const AMP_PROVIDER_PREFIXES = ['anthropic/'];
const ZERO_MODEL_PRICING = {
	inputCostPerMToken: 0,
	cachedInputCostPerMToken: 0,
	cacheCreationCostPerMToken: 0,
	outputCostPerMToken: 0,
} as const satisfies ModelPricing;

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

export type AmpPricingSourceOptions = {
	fetcher?: LiteLLMPricingFetcher;
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const PREFETCHED_AMP_PRICING = prefetchAmpPricing();

export class AmpPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;
	private readonly ownsFetcher: boolean;

	constructor(options: AmpPricingSourceOptions = {}) {
		this.ownsFetcher = options.fetcher == null;
		this.fetcher =
			options.fetcher ??
			new LiteLLMPricingFetcher({
				offline: options.offline ?? false,
				offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_AMP_PRICING),
				logger,
				providerPrefixes: AMP_PROVIDER_PREFIXES,
			});
	}

	[Symbol.dispose](): void {
		if (this.ownsFetcher) {
			this.fetcher[Symbol.dispose]();
		}
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		const pricing = directLookup.value;
		if (pricing == null) {
			logger.warn(`Pricing not found for model ${model}; defaulting to zero-cost pricing.`);
			return ZERO_MODEL_PRICING;
		}

		return {
			inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
			cachedInputCostPerMToken: toPerMillion(
				pricing.cache_read_input_token_cost,
				pricing.input_cost_per_token,
			),
			cacheCreationCostPerMToken: toPerMillion(
				pricing.cache_creation_input_token_cost,
				pricing.input_cost_per_token,
			),
			outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
		};
	}

	async calculateCost(
		model: string,
		tokens: {
			inputTokens: number;
			outputTokens: number;
			cacheCreationInputTokens?: number;
			cacheReadInputTokens?: number;
		},
	): Promise<number> {
		const pricing = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(pricing)) {
			logger.warn(`Failed to load pricing for model ${model}:`, pricing.error);
			return 0;
		}

		if (pricing.value == null) {
			logger.warn(`Pricing not found for model ${model}; defaulting to zero-cost pricing.`);
			return 0;
		}

		return this.fetcher.calculateCostFromPricing(
			{
				input_tokens: tokens.inputTokens,
				output_tokens: tokens.outputTokens,
				cache_creation_input_tokens: tokens.cacheCreationInputTokens,
				cache_read_input_tokens: tokens.cacheReadInputTokens,
			},
			pricing.value,
		);
	}
}

if (import.meta.vitest != null) {
	describe('AmpPricingSource', () => {
		it('converts LiteLLM pricing to per-million costs', async () => {
			using source = new AmpPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-haiku-4-5-20251001': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 5e-6,
						cache_read_input_token_cost: 1e-7,
						cache_creation_input_token_cost: 1.25e-6,
					},
				}),
			});

			const pricing = await source.getPricing('claude-haiku-4-5-20251001');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1);
			expect(pricing.outputCostPerMToken).toBeCloseTo(5);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.1);
			expect(pricing.cacheCreationCostPerMToken).toBeCloseTo(1.25);
		});

		it('calculates cost from tokens', async () => {
			using source = new AmpPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-haiku-4-5-20251001': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 5e-6,
						cache_read_input_token_cost: 1e-7,
						cache_creation_input_token_cost: 1.25e-6,
					},
				}),
			});

			const cost = await source.calculateCost('claude-haiku-4-5-20251001', {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
			});

			const expected = 1000 * 1e-6 + 500 * 5e-6 + 200 * 1e-7 + 100 * 1.25e-6;
			expect(cost).toBeCloseTo(expected);
		});

		it('falls back to zero pricing for unknown models', async () => {
			using source = new AmpPricingSource({
				offline: true,
				offlineLoader: async () => ({}),
			});

			const pricing = await source.getPricing('anthropic/unknown');
			expect(pricing).toEqual(ZERO_MODEL_PRICING);
		});

		it('uses Bedrock-style Claude 3.5 Haiku pricing from cached data', async () => {
			using source = new AmpPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'anthropic.claude-3-5-haiku-20241022-v1:0': {
						input_cost_per_token: 8e-7,
						output_cost_per_token: 4e-6,
						cache_read_input_token_cost: 8e-8,
						cache_creation_input_token_cost: 1e-6,
					},
				}),
			});

			const cost = await source.calculateCost('claude-3-5-haiku-20241022', {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
			});

			const expected = 1000 * 8e-7 + 500 * 4e-6 + 200 * 8e-8 + 100 * 1e-6;
			expect(cost).toBeCloseTo(expected);
		});
	});
}
