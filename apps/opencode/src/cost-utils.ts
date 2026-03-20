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
	const normalizedModelName = normalizeClaudeModelName(modelName);
	return MODEL_ALIASES[normalizedModelName] ?? normalizedModelName;
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
	describe('calculateCostForEntry', () => {
		it('normalizes dotted Claude model names before pricing lookup', async () => {
			let lookedUpModel: string | undefined;
			const fetcher = {
				calculateCostFromTokens: async (
					_tokens: {
						input_tokens: number;
						output_tokens: number;
						cache_creation_input_tokens?: number;
						cache_read_input_tokens?: number;
					},
					modelName?: string,
				) => {
					lookedUpModel = modelName;
					return Result.succeed(1.25);
				},
			} as unknown as LiteLLMPricingFetcher;

			const cost = await calculateCostForEntry(
				{
					timestamp: new Date('2026-03-10T00:00:00.000Z'),
					sessionID: 'ses_test',
					usage: {
						inputTokens: 100,
						outputTokens: 200,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'claude-opus-4.5',
					costUSD: null,
				},
				fetcher,
			);

			expect(cost).toBe(1.25);
			expect(lookedUpModel).toBe('claude-opus-4-5');
		});
	});
}
