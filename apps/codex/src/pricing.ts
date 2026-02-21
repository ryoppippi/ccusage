import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCodexPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([['gpt-5-codex', 'gpt-5']]);
const FREE_MODEL_PRICING: ModelPricing = {
	inputCostPerMToken: 0,
	cachedInputCostPerMToken: 0,
	outputCostPerMToken: 0,
};

function isOpenRouterFreeModel(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	if (normalized === 'openrouter/free') {
		return true;
	}

	return normalized.startsWith('openrouter/') && normalized.endsWith(':free');
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
		if (isOpenRouterFreeModel(model)) {
			return FREE_MODEL_PRICING;
		}

		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		let pricing = directLookup.value;
		if (pricing == null) {
			const alias = CODEX_MODEL_ALIASES_MAP.get(model);
			if (alias != null) {
				const aliasLookup = await this.fetcher.getModelPricing(alias);
				if (Result.isFailure(aliasLookup)) {
					throw aliasLookup.error;
				}
				pricing = aliasLookup.value;
			}
		}

		if (pricing == null) {
			logger.warn(`Pricing not found for model ${model}; defaulting to zero-cost pricing.`);
			return FREE_MODEL_PRICING;
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

		it('returns zero pricing for OpenRouter free routes', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({}),
			});

			const directFree = await source.getPricing('openrouter/free');
			expect(directFree).toEqual(FREE_MODEL_PRICING);

			const modelFree = await source.getPricing('openrouter/openai/gpt-5:free');
			expect(modelFree).toEqual(FREE_MODEL_PRICING);
		});

		it('falls back to zero pricing for unknown non-free models', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({}),
			});

			const pricing = await source.getPricing('openrouter/unknown');
			expect(pricing).toEqual(FREE_MODEL_PRICING);
		});
	});
}
