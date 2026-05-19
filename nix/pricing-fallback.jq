def embedded_model:
	startswith("claude-")
	or startswith("anthropic.")
	or startswith("anthropic/")
	or startswith("us.anthropic.")
	or startswith("eu.anthropic.")
	or startswith("global.anthropic.")
	or startswith("jp.anthropic.")
	or startswith("au.anthropic.")
	or startswith("gpt-")
	or startswith("openai/")
	or startswith("azure/")
	or startswith("openrouter/openai/");

def embedded_field:
	. == "input_cost_per_token"
	or . == "output_cost_per_token"
	or . == "cache_creation_input_token_cost"
	or . == "cache_read_input_token_cost"
	or . == "input_cost_per_token_above_200k_tokens"
	or . == "output_cost_per_token_above_200k_tokens"
	or . == "cache_creation_input_token_cost_above_200k_tokens"
	or . == "cache_read_input_token_cost_above_200k_tokens"
	or . == "max_input_tokens"
	or . == "provider_specific_entry";

with_entries(select(.key | embedded_model))
| with_entries(.value |= with_entries(select((.key | embedded_field) and (.value != null))))
| with_entries(select(.value | has("input_cost_per_token") and has("output_cost_per_token")))
