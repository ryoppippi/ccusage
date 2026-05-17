import type { LiteLLMModelPricing } from './pricing.ts';
import { Result } from '@praha/byethrow';
import * as v from 'valibot';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

const modelsDevCostSchema = v.object({
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	cache_read: v.optional(v.number()),
	cache_write: v.optional(v.number()),
});

const modelsDevLimitSchema = v.object({
	context: v.optional(v.number()),
	output: v.optional(v.number()),
});

const modelsDevModelSchema = v.object({
	id: v.string(),
	cost: v.optional(modelsDevCostSchema),
	limit: v.optional(modelsDevLimitSchema),
});

const modelsDevProviderSchema = v.object({
	id: v.string(),
	models: v.optional(v.record(v.string(), modelsDevModelSchema)),
});

const modelsDevApiSchema = v.record(v.string(), modelsDevProviderSchema);

export type ModelsDevModel = v.InferOutput<typeof modelsDevModelSchema>;

function toTokenPrice(pricePerMillionTokens: number | undefined): number | undefined {
	return pricePerMillionTokens == null ? undefined : pricePerMillionTokens / 1_000_000;
}

export function convertModelsDevToLiteLLMPricing(model: ModelsDevModel): LiteLLMModelPricing {
	return {
		input_cost_per_token: toTokenPrice(model.cost?.input),
		output_cost_per_token: toTokenPrice(model.cost?.output),
		cache_creation_input_token_cost: toTokenPrice(model.cost?.cache_write),
		cache_read_input_token_cost: toTokenPrice(model.cost?.cache_read),
		max_tokens: model.limit?.context,
		max_input_tokens: model.limit?.context,
		max_output_tokens: model.limit?.output,
	};
}

export async function fetchModelsDevPricing(
	url = MODELS_DEV_API_URL,
): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
	return Result.pipe(
		Result.try({
			try: fetch(url),
			catch: (error) => new Error('Failed to fetch pricing from models.dev', { cause: error }),
		}),
		Result.andThrough((response) => {
			if (!response.ok) {
				return Result.fail(
					new Error(`Failed to fetch models.dev pricing data: ${response.statusText}`),
				);
			}
			return Result.succeed();
		}),
		Result.andThen(async (response) =>
			Result.try({
				try: response.json() as Promise<Record<string, unknown>>,
				catch: (error) => new Error('Failed to parse models.dev pricing data', { cause: error }),
			}),
		),
		Result.andThen((data) => {
			const parsed = v.safeParse(modelsDevApiSchema, data);
			if (!parsed.success) {
				return Result.fail(new Error('Invalid models.dev pricing data'));
			}
			return Result.succeed(parsed.output);
		}),
		Result.map((api) => {
			const pricing = new Map<string, LiteLLMModelPricing>();
			for (const [providerId, provider] of Object.entries(api)) {
				if (provider.models == null) {
					continue;
				}
				for (const [modelId, model] of Object.entries(provider.models)) {
					const converted = convertModelsDevToLiteLLMPricing(model);
					pricing.set(modelId, converted);
					pricing.set(`${providerId}/${modelId}`, converted);
				}
			}
			return pricing;
		}),
	);
}

if (import.meta.vitest != null) {
	describe('models.dev pricing', () => {
		it('converts per-million token pricing to LiteLLM per-token pricing', () => {
			const pricing = convertModelsDevToLiteLLMPricing({
				id: 'gpt-5',
				cost: {
					input: 1.25,
					output: 10,
					cache_read: 0.125,
					cache_write: 1.25,
				},
				limit: {
					context: 400_000,
					output: 128_000,
				},
			});

			expect(pricing.input_cost_per_token).toBeCloseTo(1.25 / 1_000_000);
			expect(pricing.output_cost_per_token).toBeCloseTo(10 / 1_000_000);
			expect(pricing.cache_read_input_token_cost).toBeCloseTo(0.125 / 1_000_000);
			expect(pricing.cache_creation_input_token_cost).toBeCloseTo(1.25 / 1_000_000);
			expect(pricing.max_input_tokens).toBe(400_000);
			expect(pricing.max_output_tokens).toBe(128_000);
		});
	});
}
