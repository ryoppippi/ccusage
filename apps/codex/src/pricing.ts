import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCodexPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([
	['gpt-5-codex', 'gpt-5'],
	['gpt-5.3-codex', 'gpt-5.2-codex'],
]);

function hasNonZeroTokenPricing(pricing: LiteLLMModelPricing): boolean {
	return (
		(pricing.input_cost_per_token ?? 0) > 0 ||
		(pricing.output_cost_per_token ?? 0) > 0 ||
		(pricing.cache_read_input_token_cost ?? 0) > 0
	);
}

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

export type CodexPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const PREFETCHED_CODEX_PRICING = prefetchCodexPricing();

export class CodexPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;

	constructor(options: CodexPricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_CODEX_PRICING),
			logger,
			providerPrefixes: CODEX_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		let pricing = directLookup.value;
		const alias = CODEX_MODEL_ALIASES_MAP.get(model);
		if (alias != null && (pricing == null || !hasNonZeroTokenPricing(pricing))) {
			const aliasLookup = await this.fetcher.getModelPricing(alias);
			if (Result.isFailure(aliasLookup)) {
				throw aliasLookup.error;
			}
			if (aliasLookup.value != null && hasNonZeroTokenPricing(aliasLookup.value)) {
				pricing = aliasLookup.value;
			}
		}

		if (pricing == null) {
			throw new Error(`Pricing not found for model ${model}`);
		}

		return {
			inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
			cachedInputCostPerMToken: toPerMillion(
				pricing.cache_read_input_token_cost,
				pricing.input_cost_per_token,
			),
			outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
		};
	}
}

if (import.meta.vitest != null) {
	describe('CodexPricingSource', () => {
		it('converts LiteLLM pricing to per-million costs', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.25);
			expect(pricing.outputCostPerMToken).toBeCloseTo(10);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.125);
		});

		it('falls back to alias pricing when direct model pricing is all zeros', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5.3-codex': {
						input_cost_per_token: 0,
						output_cost_per_token: 0,
						cache_read_input_token_cost: 0,
					},
					'gpt-5.2-codex': {
						input_cost_per_token: 1.75e-6,
						output_cost_per_token: 1.4e-5,
						cache_read_input_token_cost: 1.75e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5.3-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.75);
			expect(pricing.outputCostPerMToken).toBeCloseTo(14);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.175);
		});

		it('prefers direct pricing when non-zero pricing is available', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5.3-codex': {
						input_cost_per_token: 1.9e-6,
						output_cost_per_token: 1.5e-5,
						cache_read_input_token_cost: 1.9e-7,
					},
					'gpt-5.2-codex': {
						input_cost_per_token: 1.75e-6,
						output_cost_per_token: 1.4e-5,
						cache_read_input_token_cost: 1.75e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5.3-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.9);
			expect(pricing.outputCostPerMToken).toBeCloseTo(15);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.19);
		});
	});
}
