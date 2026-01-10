/**
 * @fileoverview Pricing adapter for Factory Droid.
 *
 * Resolves per-token costs using the shared LiteLLM pricing fetcher, scoped to
 * provider prefixes typically used by Factory.
 */

import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelUsage, PricingResult, PricingSource } from './_types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createPricingDataset } from '@ccusage/internal/pricing-fetch-utils';
import { Result } from '@praha/byethrow';
import { prefetchFactoryPricing } from './_macro.ts';
import { logger } from './logger.ts';

const FACTORY_PROVIDER_PREFIXES = [
	'openai/',
	'azure/',
	'anthropic/',
	'openrouter/',
	'openrouter/openai/',
	'openrouter/anthropic/',
	'gemini/',
	'google/',
	'vertex_ai/',
];

export type FactoryPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const EMPTY_PRICING_DATASET: Record<string, LiteLLMModelPricing> = createPricingDataset();

let prefetchedPricingPromise: Promise<Record<string, LiteLLMModelPricing>> | null = null;

async function loadPrefetchedFactoryPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	if (prefetchedPricingPromise == null) {
		prefetchedPricingPromise = prefetchFactoryPricing();
	}
	return prefetchedPricingPromise;
}

function normalizeModelCandidates(rawModel: string): string[] {
	const trimmed = rawModel.trim();
	if (trimmed === '') {
		return [];
	}

	const candidates = new Set<string>([trimmed]);

	const withoutParens = trimmed.replaceAll(/\([^)]*\)/g, '').trim();
	if (withoutParens !== '') {
		candidates.add(withoutParens);
	}

	const thinkingSuffix = withoutParens.match(/^(.*?)(-thinking)(-\d+)?$/);
	if (thinkingSuffix != null) {
		const base = thinkingSuffix[1]?.trim();
		if (base != null && base !== '') {
			candidates.add(base);
		}
		candidates.add(`${thinkingSuffix[1]}${thinkingSuffix[2]}`);
	}

	return Array.from(candidates);
}

export class FactoryPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;

	/**
	 * Creates a pricing source.
	 *
	 * When `offline` is enabled, the source uses `offlineLoader` if provided.
	 */
	constructor(options: FactoryPricingSourceOptions = {}) {
		const offline = options.offline ?? false;
		this.fetcher = new LiteLLMPricingFetcher({
			offline,
			offlineLoader:
				options.offlineLoader ??
				(offline ? async () => EMPTY_PRICING_DATASET : loadPrefetchedFactoryPricing),
			logger,
			providerPrefixes: FACTORY_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	/**
	 * Calculates cost for a model usage payload.
	 *
	 * This attempts a few normalized model candidates (e.g., stripping parentheses)
	 * to match LiteLLM pricing entries.
	 */
	async calculateCost(pricingModel: string, usage: ModelUsage): Promise<PricingResult> {
		const candidates = normalizeModelCandidates(pricingModel);
		if (candidates.length === 0) {
			return { costUSD: 0, usedPricingModel: pricingModel };
		}

		let lastError: Error | undefined;
		for (const candidate of candidates) {
			const result = await this.fetcher.calculateCostFromTokens(
				{
					input_tokens: usage.inputTokens,
					output_tokens: usage.outputTokens + usage.thinkingTokens,
					cache_creation_input_tokens: usage.cacheCreationTokens,
					cache_read_input_tokens: usage.cacheReadTokens,
				},
				candidate,
			);

			if (Result.isSuccess(result)) {
				return { costUSD: result.value, usedPricingModel: candidate };
			}

			lastError = result.error;
		}

		throw lastError ?? new Error(`Pricing not found for model ${pricingModel}`);
	}
}

if (import.meta.vitest != null) {
	describe('FactoryPricingSource', () => {
		it('normalizes parentheses suffixes for pricing lookups', async () => {
			using source = new FactoryPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'openai/gpt-5.2': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
						cache_read_input_token_cost: 1e-7,
						cache_creation_input_token_cost: 1.5e-6,
					},
				}),
			});

			const cost = await source.calculateCost('gpt-5.2(high)', {
				inputTokens: 1000,
				outputTokens: 500,
				thinkingTokens: 100,
				cacheReadTokens: 200,
				cacheCreationTokens: 50,
				totalTokens: 0,
			});

			const expected = 1000 * 1e-6 + (500 + 100) * 2e-6 + 200 * 1e-7 + 50 * 1.5e-6;
			expect(cost.costUSD).toBeCloseTo(expected);
		});
	});
}
