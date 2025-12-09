import type { LiteLLMModelPricing } from "./pricing.ts";
import { Result } from "@praha/byethrow";
import * as v from "valibot";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * models.dev Model Cost Schema
 * Prices are in USD per million tokens
 */
const modelsDevCostSchema = v.object({
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	cache_read: v.optional(v.number()),
	cache_write: v.optional(v.number()),
});

/**
 * models.dev Model Limit Schema
 */
const modelsDevLimitSchema = v.object({
	context: v.optional(v.number()),
	output: v.optional(v.number()),
});

/**
 * models.dev Model Schema
 */
const modelsDevModelSchema = v.object({
	id: v.string(),
	name: v.optional(v.string()),
	cost: v.optional(modelsDevCostSchema),
	limit: v.optional(modelsDevLimitSchema),
});

/**
 * models.dev Provider Schema
 */
const modelsDevProviderSchema = v.object({
	id: v.string(),
	models: v.optional(v.record(v.string(), modelsDevModelSchema)),
});

/**
 * models.dev API Response Schema
 */
const modelsDevApiSchema = v.record(v.string(), modelsDevProviderSchema);

export type ModelsDevModel = v.InferOutput<typeof modelsDevModelSchema>;
export type ModelsDevProvider = v.InferOutput<typeof modelsDevProviderSchema>;
export type ModelsDevApiResponse = v.InferOutput<typeof modelsDevApiSchema>;

/**
 * Convert models.dev pricing to LiteLLM format
 * models.dev uses cost per million tokens, LiteLLM uses cost per token
 */
export function convertModelsDevToLiteLLM(
	model: ModelsDevModel,
): LiteLLMModelPricing {
	const cost = model.cost;
	const limit = model.limit;

	return {
		// Convert from per-million to per-token by dividing by 1,000,000
		input_cost_per_token: cost?.input != null ? cost.input / 1_000_000 : undefined,
		output_cost_per_token: cost?.output != null ? cost.output / 1_000_000 : undefined,
		cache_read_input_token_cost: cost?.cache_read != null ? cost.cache_read / 1_000_000 : undefined,
		cache_creation_input_token_cost: cost?.cache_write != null ? cost.cache_write / 1_000_000 : undefined,
		max_input_tokens: limit?.context,
		max_tokens: limit?.context,
		max_output_tokens: limit?.output,
	};
}

/**
 * Fetch and parse pricing data from models.dev API
 */
export async function fetchModelsDevPricing(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
	return Result.pipe(
		Result.try({
			try: fetch(MODELS_DEV_API_URL),
			catch: error => new Error("Failed to fetch pricing from models.dev", { cause: error }),
		}),
		Result.andThrough((response) => {
			if (!response.ok) {
				return Result.fail(new Error(`Failed to fetch models.dev pricing: ${response.statusText}`));
			}
			return Result.succeed();
		}),
		Result.andThen(async response => Result.try({
			try: response.json() as Promise<Record<string, unknown>>,
			catch: error => new Error("Failed to parse models.dev response", { cause: error }),
		})),
		Result.andThen((data) => {
			const parsed = v.safeParse(modelsDevApiSchema, data);
			if (!parsed.success) {
				return Result.fail(new Error("Invalid models.dev API response format"));
			}
			return Result.succeed(parsed.output);
		}),
		Result.map((apiResponse) => {
			const pricing = new Map<string, LiteLLMModelPricing>();

			for (const [providerId, provider] of Object.entries(apiResponse)) {
				if (provider.models == null) {
					continue;
				}

				for (const [modelId, model] of Object.entries(provider.models)) {
					// Add model with provider prefix (e.g., "anthropic/claude-sonnet-4-5")
					const providerPrefixedKey = `${providerId}/${modelId}`;
					pricing.set(providerPrefixedKey, convertModelsDevToLiteLLM(model));

					// Also add without provider prefix for easier matching
					pricing.set(modelId, convertModelsDevToLiteLLM(model));
				}
			}

			return pricing;
		}),
	);
}

if (import.meta.vitest != null) {
	describe("models.dev pricing utilities", () => {
		it("converts models.dev pricing to LiteLLM format", () => {
			const modelsDevModel: ModelsDevModel = {
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
				limit: {
					context: 200_000,
					output: 64_000,
				},
			};

			const liteLLMPricing = convertModelsDevToLiteLLM(modelsDevModel);

			expect(liteLLMPricing.input_cost_per_token).toBeCloseTo(3 / 1_000_000);
			expect(liteLLMPricing.output_cost_per_token).toBeCloseTo(15 / 1_000_000);
			expect(liteLLMPricing.cache_read_input_token_cost).toBeCloseTo(0.3 / 1_000_000);
			expect(liteLLMPricing.cache_creation_input_token_cost).toBeCloseTo(3.75 / 1_000_000);
			expect(liteLLMPricing.max_input_tokens).toBe(200_000);
			expect(liteLLMPricing.max_output_tokens).toBe(64_000);
		});

		it("handles missing cost fields gracefully", () => {
			const modelsDevModel: ModelsDevModel = {
				id: "test-model",
				cost: {
					input: 1,
					// output, cache_read, cache_write missing
				},
			};

			const liteLLMPricing = convertModelsDevToLiteLLM(modelsDevModel);

			expect(liteLLMPricing.input_cost_per_token).toBeCloseTo(1 / 1_000_000);
			expect(liteLLMPricing.output_cost_per_token).toBeUndefined();
			expect(liteLLMPricing.cache_read_input_token_cost).toBeUndefined();
			expect(liteLLMPricing.cache_creation_input_token_cost).toBeUndefined();
		});

		it("handles missing limit fields gracefully", () => {
			const modelsDevModel: ModelsDevModel = {
				id: "test-model",
			};

			const liteLLMPricing = convertModelsDevToLiteLLM(modelsDevModel);

			expect(liteLLMPricing.max_input_tokens).toBeUndefined();
			expect(liteLLMPricing.max_output_tokens).toBeUndefined();
		});
	});
}

