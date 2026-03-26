import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { Result } from '@praha/byethrow';

/**
 * Model aliases for OpenCode-specific model names that don't exist in LiteLLM.
 * Maps OpenCode model names to their LiteLLM equivalents for pricing lookup.
 */
const MODEL_ALIASES: Record<string, string> = {
	// OpenCode uses -high suffix for higher tier/thinking mode variants
	'gemini-3-pro-high': 'gemini-3-pro-preview',
	// OpenCode uses dot notation for Claude version numbers (e.g. 4.5),
	// but LiteLLM uses hyphens (e.g. 4-5)
	'claude-haiku-4.5': 'claude-haiku-4-5',
	'claude-opus-4.5': 'claude-opus-4-5',
	'claude-opus-4.6': 'claude-opus-4-6',
	'claude-sonnet-4.5': 'claude-sonnet-4-5',
	'claude-sonnet-4.6': 'claude-sonnet-4-6',
};

function resolveModelName(modelName: string): string {
	return MODEL_ALIASES[modelName] ?? modelName;
}

/**
 * Calculate cost for a single usage entry
 * Uses pre-calculated cost if available, otherwise calculates from tokens
 */
export async function calculateCostForEntry(
	entry: LoadedUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	if (entry.costUSD != null && entry.costUSD > 0) {
		return entry.costUSD;
	}

	const resolvedModel = resolveModelName(entry.model);
	const result = await fetcher.calculateCostFromTokens(
		{
			input_tokens: entry.usage.inputTokens,
			output_tokens: entry.usage.outputTokens,
			cache_creation_input_tokens: entry.usage.cacheCreationInputTokens,
			cache_read_input_tokens: entry.usage.cacheReadInputTokens,
		},
		resolvedModel,
	);

	return Result.unwrap(result, 0);
}
