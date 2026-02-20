import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingResolution, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCodexPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([['gpt-5-codex', 'gpt-5']]);

function toPerMillion(value: number, fallback?: number): number {
	const perToken = value ?? fallback;
	if (perToken == null) {
		throw new Error('Missing required pricing value');
	}
	return perToken * MILLION;
}

export type CodexPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
	allowFuzzyPricing?: boolean;
	unknownModelFallback?: string;
};

const PREFETCHED_CODEX_PRICING = prefetchCodexPricing();

export class CodexPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;
	private readonly allowFuzzyPricing: boolean;
	private readonly unknownModelFallback?: string;

	constructor(options: CodexPricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_CODEX_PRICING),
			logger,
			providerPrefixes: CODEX_PROVIDER_PREFIXES,
		});
		this.allowFuzzyPricing = options.allowFuzzyPricing ?? false;
		this.unknownModelFallback = options.unknownModelFallback;
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	private async getPricingMap(): Promise<Map<string, LiteLLMModelPricing>> {
		const pricingLookup = await this.fetcher.fetchModelPricing();
		if (Result.isFailure(pricingLookup)) {
			throw pricingLookup.error;
		}
		return pricingLookup.value;
	}

	private createResolvedPricing(
		key: string,
		pricing: LiteLLMModelPricing,
		resolution: PricingResolution,
	): { key: string; pricing: LiteLLMModelPricing; resolution: PricingResolution } {
		return { key, pricing, resolution };
	}

	private findDirectPricing(
		pricingMap: Map<string, LiteLLMModelPricing>,
		model: string,
	): { key: string; pricing: LiteLLMModelPricing; resolution: PricingResolution } | null {
		const candidates = [model, ...CODEX_PROVIDER_PREFIXES.map((prefix) => `${prefix}${model}`)];
		for (const candidate of candidates) {
			const pricing = pricingMap.get(candidate);
			if (pricing != null) {
				return this.createResolvedPricing(candidate, pricing, 'direct');
			}
		}
		return null;
	}

	private findAliasPricing(
		pricingMap: Map<string, LiteLLMModelPricing>,
		model: string,
	): { key: string; pricing: LiteLLMModelPricing; resolution: PricingResolution } | null {
		const alias = CODEX_MODEL_ALIASES_MAP.get(model);
		if (alias == null) {
			return null;
		}
		const aliasPricing = this.findDirectPricing(pricingMap, alias);
		if (aliasPricing == null) {
			return null;
		}
		return this.createResolvedPricing(aliasPricing.key, aliasPricing.pricing, 'alias');
	}

	private findFuzzyPricing(
		pricingMap: Map<string, LiteLLMModelPricing>,
		model: string,
	): { key: string; pricing: LiteLLMModelPricing; resolution: PricingResolution } | null {
		const lower = model.toLowerCase();
		const matches: Array<{ key: string; pricing: LiteLLMModelPricing }> = [];
		for (const [key, value] of pricingMap) {
			const comparison = key.toLowerCase();
			if (comparison.includes(lower) || lower.includes(comparison)) {
				matches.push({ key, pricing: value });
			}
		}

		if (matches.length === 0) {
			return null;
		}
		if (matches.length > 1) {
			throw new Error(
				`Ambiguous fuzzy pricing resolution for model ${model}; ${matches.length} candidates found: ${matches
					.map((x) => x.key)
					.join(', ')}`,
			);
		}
		const match = matches[0];
		if (match == null) {
			return null;
		}
		return this.createResolvedPricing(match.key, match.pricing, 'fuzzy');
	}

	private normalizeModelPricing(
		model: string,
		resolved: { key: string; pricing: LiteLLMModelPricing; resolution: PricingResolution },
	): ModelPricing {
		const { pricing, key, resolution } = resolved;
		const inputCostPerToken = pricing.input_cost_per_token;
		const outputCostPerToken = pricing.output_cost_per_token;
		if (inputCostPerToken == null || outputCostPerToken == null) {
			throw new Error(
				`Pricing for model ${model} is incomplete: input_cost_per_token and output_cost_per_token are required`,
			);
		}

		return {
			inputCostPerMToken: toPerMillion(inputCostPerToken),
			cachedInputCostPerMToken: toPerMillion(
				pricing.cache_read_input_token_cost ?? inputCostPerToken,
			),
			outputCostPerMToken: toPerMillion(outputCostPerToken),
			pricingResolution: resolution,
			pricingModel: key,
		};
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const pricingMap = await this.getPricingMap();

		let resolvedPricing = this.findDirectPricing(pricingMap, model);
		if (resolvedPricing == null) {
			resolvedPricing = this.findAliasPricing(pricingMap, model);
		}

		if (resolvedPricing == null && this.allowFuzzyPricing) {
			resolvedPricing = this.findFuzzyPricing(pricingMap, model);
		}

		if (resolvedPricing == null && this.unknownModelFallback != null) {
			const fallbackModel = this.unknownModelFallback.trim();
			if (fallbackModel !== '') {
				const fallbackPricing =
					this.findDirectPricing(pricingMap, fallbackModel) ??
					this.findAliasPricing(pricingMap, fallbackModel);
				if (fallbackPricing == null) {
					throw new Error(
						`Configured fallback model ${fallbackModel} could not be resolved for ${model}`,
					);
				}
				logger.warn(`Using fallback model pricing: ${model} -> ${fallbackModel}`);
				resolvedPricing = this.createResolvedPricing(
					fallbackPricing.key,
					fallbackPricing.pricing,
					'fallback',
				);
			}
		}

		if (resolvedPricing == null) {
			if (!this.allowFuzzyPricing) {
				throw new Error(
					`Pricing not found for model ${model}. Fuzzy matching is disabled; pass --allow-fuzzy-pricing to enable it.`,
				);
			}
			throw new Error(`Pricing not found for model ${model}`);
		}

		return this.normalizeModelPricing(model, resolvedPricing);
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

		it('fails when required pricing fields are missing', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5.3-codex': {
						max_tokens: 128_000,
					},
				}),
			});

			await expect(source.getPricing('gpt-5.3-codex')).rejects.toThrow(
				'incomplete: input_cost_per_token and output_cost_per_token are required',
			);
		});

		it('fails when unknown model has no fallback and fuzzy is disabled', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5.2-codex': {
						input_cost_per_token: 1.75e-6,
						output_cost_per_token: 1.4e-5,
						cache_read_input_token_cost: 1.75e-7,
					},
				}),
			});

			await expect(source.getPricing('gpt-5.3-codex')).rejects.toThrow(
				'Fuzzy matching is disabled',
			);
		});

		it('uses configured unknown model fallback when resolution fails', async () => {
			using source = new CodexPricingSource({
				offline: true,
				unknownModelFallback: 'gpt-5.2-codex',
				offlineLoader: async () => ({
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
	});
}
