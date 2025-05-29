export interface ModelSpec {
	max_tokens?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	input_cost_per_token: number;
	output_cost_per_token: number;
	output_cost_per_reasoning_token?: number;
	litellm_provider?: string;
	mode?: string;
	supports_function_calling?: boolean;
	supports_parallel_function_calling?: boolean;
	supports_vision?: boolean;
	supports_audio_input?: boolean;
	supports_audio_output?: boolean;
	supports_prompt_caching?: boolean;
	supports_response_schema?: boolean;
	supports_system_messages?: boolean;
	supports_reasoning?: boolean;
	supports_web_search?: boolean;
	search_context_cost_per_query?: {
		search_context_size_low: number;
		search_context_size_medium: number;
		search_context_size_high: number;
	};
	deprecation_date?: string;
}

export interface LiteLLMModelPrices {
	[modelName: string]: ModelSpec;
}
