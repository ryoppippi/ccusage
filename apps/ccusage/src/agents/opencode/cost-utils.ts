import type { LoadedUsageEntry } from './data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';

/**
 * Model aliases for OpenCode-specific model names that don't exist in LiteLLM.
 * Maps OpenCode model names to their LiteLLM equivalents for pricing lookup.
 */
const MODEL_ALIASES: Record<string, string> = {
	// OpenCode uses -high suffix for higher tier/thinking mode variants
	'gemini-3-pro-high': 'gemini-3-pro-preview',
};

function resolveModelName(modelName: string): string {
	return MODEL_ALIASES[modelName] ?? modelName;
}

function normalizeOpenCodeProviderID(providerID: string): string {
	return providerID.replaceAll('-', '_');
}

function normalizeOpenCodeModelName(modelName: string): string {
	const resolved = resolveModelName(modelName);

	return resolved
		.replace(/^(claude-(?:haiku|opus|sonnet)-\d+)\.(\d+)(-.*)?$/u, '$1-$2$3')
		.replace(/^(claude-(?:haiku|opus|sonnet)-\d)(\d)(-.*)?$/u, '$1-$2$3');
}

function createModelCandidates(entry: LoadedUsageEntry): string[] {
	const resolved = resolveModelName(entry.model);
	const normalized = normalizeOpenCodeModelName(resolved);
	const baseCandidates = normalized === resolved ? [resolved] : [normalized];
	const candidates = [...baseCandidates];

	if (entry.providerID !== 'unknown') {
		const providerPrefix = normalizeOpenCodeProviderID(entry.providerID);
		candidates.push(...baseCandidates.map((candidate) => `${providerPrefix}/${candidate}`));
	}

	return Array.from(new Set(candidates));
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

	const tokens = {
		input_tokens: entry.usage.inputTokens,
		output_tokens: entry.usage.outputTokens,
		cache_creation_input_tokens: entry.usage.cacheCreationInputTokens,
		cache_read_input_tokens: entry.usage.cacheReadInputTokens,
	};

	for (const candidate of createModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}

if (import.meta.vitest != null) {
	const { describe, expect, it } = import.meta.vitest;

	function createEntry(model: string, providerID = 'github-copilot'): LoadedUsageEntry {
		return {
			timestamp: new Date('2026-01-01T00:00:00Z'),
			sessionID: 'session',
			usage: {
				inputTokens: 1000,
				outputTokens: 100,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			},
			model,
			providerID,
			costUSD: null,
		};
	}

	describe('calculateCostForEntry', () => {
		it('normalizes OpenCode Claude dot notation without hard-coded aliases', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'github_copilot/claude-opus-4.7': {},
					'claude-opus-4-1': {
						input_cost_per_token: 99,
						output_cost_per_token: 99,
					},
					'claude-opus-4-7': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			await expect(
				calculateCostForEntry(createEntry('claude-opus-4.7'), fetcher),
			).resolves.toBeCloseTo(0.0012);
		});

		it('normalizes compact Claude minor versions', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'claude-opus-4-1': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			await expect(
				calculateCostForEntry(createEntry('claude-opus-41'), fetcher),
			).resolves.toBeCloseTo(0.0012);
		});

		it('normalizes future Claude generations', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'claude-opus-5-1': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			await expect(
				calculateCostForEntry(createEntry('claude-opus-5.1'), fetcher),
			).resolves.toBeCloseTo(0.0012);
		});

		it('uses provider-prefixed pricing candidates after base model candidates', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'xai/grok-code-fast-1': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			await expect(
				calculateCostForEntry(createEntry('grok-code-fast-1', 'xai'), fetcher),
			).resolves.toBeCloseTo(0.0012);
		});
	});
}
