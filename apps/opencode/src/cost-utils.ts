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
};

function normalizeClaudeModelName(modelName: string): string {
	return modelName.replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/, 'claude-$1-$2-$3');
}

function resolveModelName(modelName: string): string {
	const normalized = normalizeClaudeModelName(modelName);
	return MODEL_ALIASES[normalized] ?? normalized;
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

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('normalizeClaudeModelName', () => {
		it('converts dot notation to dash notation', () => {
			expect(normalizeClaudeModelName('claude-opus-4.5')).toBe('claude-opus-4-5');
			expect(normalizeClaudeModelName('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
			expect(normalizeClaudeModelName('claude-haiku-4.5')).toBe('claude-haiku-4-5');
		});

		it('leaves already-normalized names unchanged', () => {
			expect(normalizeClaudeModelName('claude-opus-4-5')).toBe('claude-opus-4-5');
			expect(normalizeClaudeModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
		});

		it('leaves non-Claude model names unchanged', () => {
			expect(normalizeClaudeModelName('gpt-5.1')).toBe('gpt-5.1');
			expect(normalizeClaudeModelName('gemini-3-pro-high')).toBe('gemini-3-pro-high');
		});
	});

	describe('resolveModelName', () => {
		it('normalizes then applies aliases', () => {
			expect(resolveModelName('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
			expect(resolveModelName('gemini-3-pro-high')).toBe('gemini-3-pro-preview');
		});

		it('passes through unknown models', () => {
			expect(resolveModelName('gpt-5.1')).toBe('gpt-5.1');
		});
	});
}
