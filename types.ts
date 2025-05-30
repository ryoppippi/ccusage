import * as v from "valibot";

export const ModelSpecSchema = v.object({
	max_tokens: v.optional(v.union([v.number(), v.string()])),
	max_input_tokens: v.optional(v.union([v.number(), v.string()])),
	max_output_tokens: v.optional(v.union([v.number(), v.string()])),
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	output_cost_per_reasoning_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
	litellm_provider: v.optional(v.string()),
	mode: v.optional(v.string()),
	supports_function_calling: v.optional(v.boolean()),
	supports_parallel_function_calling: v.optional(v.boolean()),
	supports_vision: v.optional(v.boolean()),
	supports_audio_input: v.optional(v.boolean()),
	supports_audio_output: v.optional(v.boolean()),
	supports_prompt_caching: v.optional(v.boolean()),
	supports_response_schema: v.optional(v.boolean()),
	supports_system_messages: v.optional(v.boolean()),
	supports_reasoning: v.optional(v.boolean()),
	supports_web_search: v.optional(v.boolean()),
	search_context_cost_per_query: v.optional(
		v.object({
			search_context_size_low: v.number(),
			search_context_size_medium: v.number(),
			search_context_size_high: v.number(),
		}),
	),
	deprecation_date: v.optional(v.string()),
});

export type ModelSpec = v.InferOutput<typeof ModelSpecSchema>;

export const LiteLLMModelPricesSchema = v.record(v.string(), ModelSpecSchema);

export type LiteLLMModelPrices = v.InferOutput<typeof LiteLLMModelPricesSchema>;

export const dateSchema = v.pipe(
	v.string(),
	v.regex(/^\d{8}$/, "Date must be in YYYYMMDD format"),
);

export interface TokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
}

export interface TokenData {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
}
