import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { Result } from '@praha/byethrow';

/**
 * Model aliases for OpenCode-specific model names that don't exist in LiteLLM.
 * Maps OpenCode model names to their LiteLLM equivalents for pricing lookup.
 *
 * GitHub Copilot uses dot notation (e.g., claude-opus-4.5) while LiteLLM uses
 * hyphen notation (e.g., claude-opus-4-5). This mapping handles those differences.
 *
 * GitHub Copilot model names are sourced from: https://models.dev/api.json
 */
const MODEL_ALIASES: Record<string, string> = {
	// GitHub Copilot uses dots, LiteLLM uses hyphens for Claude 4.5 models
	'claude-opus-4.5': 'claude-opus-4-5',
	'claude-sonnet-4.5': 'claude-sonnet-4-5',
	'claude-haiku-4.5': 'claude-haiku-4-5',
	// GitHub Copilot shorthand names for Claude 4 models
	'claude-opus-4': 'claude-opus-4-20250514',
	'claude-opus-41': 'claude-opus-4-1',
	'claude-sonnet-4': 'claude-sonnet-4-20250514',
	// GitHub Copilot Claude 3.x model names
	'claude-3.5-sonnet': 'claude-3-5-sonnet-latest',
	'claude-3.7-sonnet': 'claude-3-7-sonnet-latest',
	// Extended thinking variant uses same pricing as base model
	'claude-3.7-sonnet-thought': 'claude-3-7-sonnet-latest',
	// Grok models require provider prefix
	'grok-code-fast-1': 'xai/grok-code-fast-1',
	// OpenCode uses -high suffix for higher tier/thinking mode variants
	'gemini-3-pro-high': 'gemini-3-pro-preview',
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
