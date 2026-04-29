import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { MILLION } from './_consts.ts';
import { prefetchCopilotPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const COPILOT_PROVIDER_PREFIXES = ['anthropic/', 'openai/'];
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

/**
 * Normalize Copilot CLI model names to LiteLLM format.
 *
 * Copilot uses dot-notation (claude-opus-4.6) while LiteLLM uses
 * dash-notation (claude-opus-4-6). Also strips variant suffixes
 * like "-1m" that don't have separate LiteLLM entries.
 */
export function normalizeCopilotModelName(model: string): string {
	// Strip known variant suffixes (e.g., "-1m" for extended context)
	let normalized = model.replace(/-1m$/i, '');

	// For Claude models: convert dots to dashes in version numbers
	// e.g., "claude-opus-4.6" → "claude-opus-4-6"
	// But NOT for GPT models where dots are standard (gpt-5.4 works as-is)
	if (normalized.startsWith('claude-')) {
		normalized = normalized.replace(/(\d+)\.(\d+)/g, '$1-$2');
	}

	return normalized;
}

export type CopilotPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const PREFETCHED_COPILOT_PRICING = prefetchCopilotPricing();

export class CopilotPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;

	constructor(options: CopilotPricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			offlineLoader: options.offlineLoader ?? (async () => PREFETCHED_COPILOT_PRICING),
			logger,
			providerPrefixes: COPILOT_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const normalized = normalizeCopilotModelName(model);
		const directLookup = await this.fetcher.getModelPricing(normalized);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		const pricing = directLookup.value;
		if (pricing == null) {
			logger.warn(
				`Pricing not found for model ${model} (normalized: ${normalized}); defaulting to zero-cost pricing.`,
			);
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
			cacheWriteTokens?: number;
			cacheReadTokens?: number;
		},
	): Promise<number> {
		const normalized = normalizeCopilotModelName(model);
		const result = await this.fetcher.calculateCostFromTokens(
			{
				input_tokens: tokens.inputTokens,
				output_tokens: tokens.outputTokens,
				cache_creation_input_tokens: tokens.cacheWriteTokens,
				cache_read_input_tokens: tokens.cacheReadTokens,
			},
			normalized,
		);

		if (Result.isFailure(result)) {
			logger.warn(
				`Failed to calculate cost for model ${model} (normalized: ${normalized}):`,
				result.error,
			);
			return 0;
		}

		return result.value;
	}
}

if (import.meta.vitest != null) {
	describe('normalizeCopilotModelName', () => {
		it('converts dots to dashes for Claude models', () => {
			expect(normalizeCopilotModelName('claude-opus-4.6')).toBe('claude-opus-4-6');
			expect(normalizeCopilotModelName('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
			expect(normalizeCopilotModelName('claude-haiku-4.5')).toBe('claude-haiku-4-5');
		});

		it('strips -1m variant suffix', () => {
			expect(normalizeCopilotModelName('claude-opus-4.6-1m')).toBe('claude-opus-4-6');
		});

		it('preserves GPT model names (dots are standard)', () => {
			expect(normalizeCopilotModelName('gpt-5.4')).toBe('gpt-5.4');
			expect(normalizeCopilotModelName('gpt-5.2')).toBe('gpt-5.2');
			expect(normalizeCopilotModelName('gpt-5.1')).toBe('gpt-5.1');
		});

		it('passes through unknown models unchanged', () => {
			expect(normalizeCopilotModelName('goldeneye')).toBe('goldeneye');
		});
	});

	describe('CopilotPricingSource', () => {
		it('converts LiteLLM pricing to per-million costs', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-opus-4-6': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 5e-6,
						cache_read_input_token_cost: 1e-7,
						cache_creation_input_token_cost: 1.25e-6,
					},
				}),
			});

			// Pass the Copilot model name — normalization should resolve it
			const pricing = await source.getPricing('claude-opus-4.6');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1);
			expect(pricing.outputCostPerMToken).toBeCloseTo(5);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.1);
			expect(pricing.cacheCreationCostPerMToken).toBeCloseTo(1.25);
		});

		it('resolves -1m variant to base model pricing', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-opus-4-6': {
						input_cost_per_token: 5e-6,
						output_cost_per_token: 2.5e-5,
					},
				}),
			});

			const pricing = await source.getPricing('claude-opus-4.6-1m');
			expect(pricing.inputCostPerMToken).toBeCloseTo(5);
			expect(pricing.outputCostPerMToken).toBeCloseTo(25);
		});

		it('calculates cost from tokens with normalized model name', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'claude-opus-4-6': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 5e-6,
						cache_read_input_token_cost: 1e-7,
						cache_creation_input_token_cost: 1.25e-6,
					},
				}),
			});

			const cost = await source.calculateCost('claude-opus-4.6', {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheWriteTokens: 100,
			});

			const expected = 1000 * 1e-6 + 500 * 5e-6 + 200 * 1e-7 + 100 * 1.25e-6;
			expect(cost).toBeCloseTo(expected);
		});

		it('falls back to zero pricing for unknown models', async () => {
			using source = new CopilotPricingSource({
				offline: true,
				offlineLoader: async () => ({}),
			});

			const pricing = await source.getPricing('unknown-model');
			expect(pricing).toEqual(ZERO_MODEL_PRICING);
		});
	});
}
