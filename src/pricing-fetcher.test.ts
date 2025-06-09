import { describe, expect, it } from 'bun:test';
import {
	type ModelPricing,
	PricingFetcher,
} from './pricing-fetcher.ts';

describe('pricing-fetcher', () => {
	describe('PricingFetcher class', () => {
		it('should support using statement for automatic cleanup', async () => {
			let fetcherDisposed = false;

			class TestPricingFetcher extends PricingFetcher {
				override [Symbol.dispose](): void {
					super[Symbol.dispose]();
					fetcherDisposed = true;
				}
			}

			{
				using fetcher = new TestPricingFetcher();
				const pricing = await fetcher.fetchModelPricing();
				expect(pricing.size).toBeGreaterThan(0);
			}

			expect(fetcherDisposed).toBe(true);
		});

		it('should calculate costs directly with model name', async () => {
			using fetcher = new PricingFetcher();

			const cost = await fetcher.calculateCostFromTokens(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				'claude-sonnet-4-20250514',
			);

			expect(cost).toBeGreaterThan(0);
		});
	});

	describe('fetchModelPricing', () => {
		it('should fetch and parse pricing data from LiteLLM', async () => {
			using fetcher = new PricingFetcher();
			const pricing = await fetcher.fetchModelPricing();

			// Should have pricing data
			expect(pricing.size).toBeGreaterThan(0);

			// Check for Claude models
			const claudeModels = Array.from(pricing.keys()).filter(model =>
				model.toLowerCase().includes('claude'),
			);
			expect(claudeModels.length).toBeGreaterThan(0);
		});

		it('should cache pricing data', async () => {
			using fetcher = new PricingFetcher();
			// First call should fetch from network
			const firstResult = await fetcher.fetchModelPricing();
			const firstKeys = Array.from(firstResult.keys());

			// Second call should use cache (and be instant)
			const startTime = Date.now();
			const secondResult = await fetcher.fetchModelPricing();
			const endTime = Date.now();

			// Should be very fast (< 5ms) if cached
			expect(endTime - startTime).toBeLessThan(5);

			// Should have same data
			expect(Array.from(secondResult.keys())).toEqual(firstKeys);
		});
	});

	describe('getModelPricing', () => {
		it('should find models by exact match', async () => {
			using fetcher = new PricingFetcher();

			// Test with a known Claude model from LiteLLM
			const pricing = await fetcher.getModelPricing('claude-sonnet-4-20250514');
			expect(pricing).not.toBeNull();
		});

		it('should find models with partial matches', async () => {
			using fetcher = new PricingFetcher();

			// Test partial matching
			const pricing = await fetcher.getModelPricing('claude-sonnet-4');
			expect(pricing).not.toBeNull();
		});

		it('should return null for unknown models', async () => {
			using fetcher = new PricingFetcher();

			const pricing = await fetcher.getModelPricing(
				'definitely-not-a-real-model-xyz',
			);
			expect(pricing).toBeNull();
		});
	});

	describe('calculateCostFromTokens', () => {
		it('should calculate cost for claude-sonnet-4-20250514', async () => {
			using fetcher = new PricingFetcher();
			const modelName = 'claude-sonnet-4-20250514';
			const pricing = await fetcher.getModelPricing(modelName);

			// This model should exist in LiteLLM
			expect(pricing).not.toBeNull();
			expect(pricing?.input_cost_per_token).not.toBeUndefined();
			expect(pricing?.output_cost_per_token).not.toBeUndefined();

			if (pricing == null) {
				throw new Error('Expected pricing for claude-sonnet-4-20250514');
			}

			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				pricing,
			);

			expect(cost).toBeGreaterThan(0);
		});

		it('should calculate cost including cache tokens for claude-sonnet-4-20250514', async () => {
			using fetcher = new PricingFetcher();
			const modelName = 'claude-sonnet-4-20250514';
			const pricing = await fetcher.getModelPricing(modelName);

			// Skip if cache pricing not available
			if (
				pricing?.cache_creation_input_token_cost == null
				|| pricing?.cache_read_input_token_cost == null
			) {
				return;
			}

			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 300,
				},
				pricing,
			);

			const expectedCost
				= 1000 * (pricing.input_cost_per_token ?? 0)
					+ 500 * (pricing.output_cost_per_token ?? 0)
					+ 200 * pricing.cache_creation_input_token_cost
					+ 300 * pricing.cache_read_input_token_cost;

			expect(cost).toBeCloseTo(expectedCost);
			expect(cost).toBeGreaterThan(0);
		});

		it('should calculate cost for claude-opus-4-20250514', async () => {
			using fetcher = new PricingFetcher();
			const modelName = 'claude-opus-4-20250514';
			const pricing = await fetcher.getModelPricing(modelName);

			// This model should exist in LiteLLM
			expect(pricing).not.toBeNull();
			expect(pricing?.input_cost_per_token).not.toBeUndefined();
			expect(pricing?.output_cost_per_token).not.toBeUndefined();

			if (pricing == null) {
				throw new Error('Expected pricing for claude-opus-4-20250514');
			}

			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				pricing,
			);

			expect(cost).toBeGreaterThan(0);
		});

		it('should calculate cost including cache tokens for claude-opus-4-20250514', async () => {
			using fetcher = new PricingFetcher();
			const modelName = 'claude-opus-4-20250514';
			const pricing = await fetcher.getModelPricing(modelName);

			// Skip if cache pricing not available
			if (
				pricing?.cache_creation_input_token_cost == null
				|| pricing?.cache_read_input_token_cost == null
			) {
				return;
			}

			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 300,
				},
				pricing,
			);

			const expectedCost
				= 1000 * (pricing.input_cost_per_token ?? 0)
					+ 500 * (pricing.output_cost_per_token ?? 0)
					+ 200 * pricing.cache_creation_input_token_cost
					+ 300 * pricing.cache_read_input_token_cost;

			expect(cost).toBeCloseTo(expectedCost);
			expect(cost).toBeGreaterThan(0);
		});

		it('should handle missing pricing fields', () => {
			using fetcher = new PricingFetcher();
			const partialPricing: ModelPricing = {
				input_cost_per_token: 0.00001,
				// output_cost_per_token is missing
			};

			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				partialPricing,
			);

			// Should only calculate input cost
			expect(cost).toBeCloseTo(1000 * 0.00001);
		});

		it('should return 0 for empty pricing', () => {
			using fetcher = new PricingFetcher();
			const emptyPricing: ModelPricing = {};

			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				emptyPricing,
			);

			expect(cost).toBe(0);
		});
	});
});
