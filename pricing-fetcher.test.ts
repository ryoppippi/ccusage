import { beforeEach, describe, expect, it } from "bun:test";
import {
	type ModelPricing,
	calculateCostFromTokens,
	clearPricingCache,
	fetchModelPricing,
	getModelPricing,
} from "./pricing-fetcher.ts";

describe("pricing-fetcher", () => {
	beforeEach(() => {
		clearPricingCache();
	});

	describe("fetchModelPricing", () => {
		it("should fetch and parse pricing data from LiteLLM", async () => {
			const pricing = await fetchModelPricing();

			// Should have pricing data
			expect(Object.keys(pricing).length).toBeGreaterThan(0);

			// Check for Claude models
			const claudeModels = Object.keys(pricing).filter((model) =>
				model.toLowerCase().includes("claude"),
			);
			expect(claudeModels.length).toBeGreaterThan(0);
		});

		it("should cache pricing data", async () => {
			// First call should fetch from network
			const firstResult = await fetchModelPricing();
			const firstKeys = Object.keys(firstResult);

			// Second call should use cache (and be instant)
			const startTime = Date.now();
			const secondResult = await fetchModelPricing();
			const endTime = Date.now();

			// Should be very fast (< 5ms) if cached
			expect(endTime - startTime).toBeLessThan(5);

			// Should have same data
			expect(Object.keys(secondResult)).toEqual(firstKeys);
		});
	});

	describe("getModelPricing", () => {
		it("should find models by exact match", async () => {
			const realPricing = await fetchModelPricing();

			// Test with a known Claude model from LiteLLM
			const pricing = getModelPricing(
				"claude-3-5-sonnet-20241022",
				realPricing,
			);
			expect(pricing).toBeTruthy();
		});

		it("should find models with partial matches", async () => {
			const realPricing = await fetchModelPricing();

			// Test partial matching
			const pricing = getModelPricing("claude-3-5-sonnet", realPricing);
			expect(pricing).toBeTruthy();
		});

		it("should find models with provider prefix", async () => {
			const realPricing = await fetchModelPricing();

			// First check if anthropic prefixed version exists
			const anthropicPricing =
				realPricing["anthropic/claude-3-5-sonnet-20241022"];
			if (anthropicPricing) {
				const pricing = getModelPricing(
					"claude-3-5-sonnet-20241022",
					realPricing,
				);
				expect(pricing).toBeTruthy();
			}
		});

		it("should return null for unknown models", async () => {
			const realPricing = await fetchModelPricing();

			const pricing = getModelPricing(
				"definitely-not-a-real-model-xyz",
				realPricing,
			);
			expect(pricing).toBeNull();
		});
	});

	describe("calculateCostFromTokens", () => {
		it("should calculate cost for claude-3-5-sonnet-20241022", async () => {
			const realPricing = await fetchModelPricing();
			const modelName = "claude-3-5-sonnet-20241022";
			const pricing = realPricing[modelName];

			// This model should exist in LiteLLM
			expect(pricing).toBeTruthy();
			expect(pricing?.input_cost_per_token).toBeTruthy();
			expect(pricing?.output_cost_per_token).toBeTruthy();

			if (!pricing) {
				throw new Error("Expected pricing for claude-3-5-sonnet-20241022");
			}

			const cost = calculateCostFromTokens(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				pricing,
			);

			expect(cost).toBeGreaterThan(0);
		});

		it("should calculate cost including cache tokens for claude-3-5-sonnet-20241022", async () => {
			const realPricing = await fetchModelPricing();
			const modelName = "claude-3-5-sonnet-20241022";
			const pricing = realPricing[modelName];

			// Skip if cache pricing not available
			if (
				!pricing?.cache_creation_input_token_cost ||
				!pricing?.cache_read_input_token_cost
			) {
				return;
			}

			const cost = calculateCostFromTokens(
				{
					input_tokens: 1000,
					output_tokens: 500,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 300,
				},
				pricing,
			);

			const expectedCost =
				1000 * (pricing.input_cost_per_token ?? 0) +
				500 * (pricing.output_cost_per_token ?? 0) +
				200 * pricing.cache_creation_input_token_cost +
				300 * pricing.cache_read_input_token_cost;

			expect(cost).toBeCloseTo(expectedCost);
			expect(cost).toBeGreaterThan(0);
		});

		it("should handle missing pricing fields", () => {
			const partialPricing: ModelPricing = {
				input_cost_per_token: 0.00001,
				// output_cost_per_token is missing
			};

			const cost = calculateCostFromTokens(
				{
					input_tokens: 1000,
					output_tokens: 500,
				},
				partialPricing,
			);

			// Should only calculate input cost
			expect(cost).toBeCloseTo(1000 * 0.00001);
		});

		it("should return 0 for empty pricing", () => {
			const emptyPricing: ModelPricing = {};

			const cost = calculateCostFromTokens(
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
