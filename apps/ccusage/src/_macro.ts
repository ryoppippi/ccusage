import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

function isClaudeModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return (
		modelName.startsWith('claude-') ||
		modelName.startsWith('anthropic.claude-') ||
		modelName.startsWith('anthropic/claude-')
	);
}

/**
 * Anthropic API pricing for 1M-context models that use flat (non-tiered) pricing.
 *
 * Claude Opus 4.6 and Sonnet 4.6 include the full 1M context window at standard
 * pricing — there is no premium for requests exceeding 200k input tokens.
 * See: https://docs.anthropic.com/en/docs/about-claude/pricing#long-context-pricing
 *
 * LiteLLM's dataset only contains Bedrock entries (e.g. `anthropic.claude-opus-4-6-v1`)
 * which carry `*_above_200k_tokens` fields for Bedrock-specific tiered pricing.
 * When ccusage falls back to substring matching, it picks up those Bedrock entries
 * and incorrectly applies tiered pricing to direct Anthropic API usage, inflating costs.
 *
 * By injecting entries keyed by the exact Anthropic API model names, direct lookup
 * succeeds before the substring fallback ever fires.
 */
const ANTHROPIC_API_FLAT_PRICING: Record<string, LiteLLMModelPricing> = {
	'claude-opus-4-6': {
		input_cost_per_token: 5e-6, // $5 / MTok
		output_cost_per_token: 2.5e-5, // $25 / MTok
		cache_creation_input_token_cost: 6.25e-6, // $6.25 / MTok (1.25x input)
		cache_read_input_token_cost: 5e-7, // $0.50 / MTok (0.1x input)
		max_input_tokens: 1_000_000,
		max_output_tokens: 128_000,
	},
	'claude-sonnet-4-6': {
		input_cost_per_token: 3e-6, // $3 / MTok
		output_cost_per_token: 1.5e-5, // $15 / MTok
		cache_creation_input_token_cost: 3.75e-6, // $3.75 / MTok (1.25x input)
		cache_read_input_token_cost: 3e-7, // $0.30 / MTok (0.1x input)
		max_input_tokens: 1_000_000,
		max_output_tokens: 64_000,
	},
};

export async function prefetchClaudePricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		const filtered = filterPricingDataset(dataset, isClaudeModel);
		// Inject flat-pricing entries for Anthropic API model names so that
		// direct lookup matches before falling back to Bedrock substring matches.
		return { ...filtered, ...ANTHROPIC_API_FLAT_PRICING };
	} catch (error) {
		console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
