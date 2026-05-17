import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { OpenCodeUsageEntry } from './schema.ts';
import { Result } from '@praha/byethrow';

const MODEL_ALIASES: Record<string, string> = {
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

function createModelCandidates(entry: OpenCodeUsageEntry): string[] {
	const resolved = resolveModelName(entry.model);
	const normalized = normalizeOpenCodeModelName(resolved);
	const baseCandidates = normalized === resolved ? [resolved] : [resolved, normalized];
	const candidates = [...baseCandidates];
	if (entry.providerID !== 'unknown') {
		const providerPrefix = normalizeOpenCodeProviderID(entry.providerID);
		candidates.push(...baseCandidates.map((candidate) => `${providerPrefix}/${candidate}`));
	}
	return Array.from(new Set(candidates));
}

if (import.meta.vitest != null) {
	describe('createModelCandidates', () => {
		it('keeps both original and normalized model names before provider-prefixed candidates', () => {
			expect(
				createModelCandidates({
					timestamp: new Date('2026-05-01T00:00:00.000Z'),
					sessionID: 'session-a',
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'claude-sonnet-4.5',
					providerID: 'anthropic',
					costUSD: null,
				}),
			).toEqual([
				'claude-sonnet-4.5',
				'claude-sonnet-4-5',
				'anthropic/claude-sonnet-4.5',
				'anthropic/claude-sonnet-4-5',
			]);
		});
	});
}

export async function calculateOpenCodeCost(
	entry: OpenCodeUsageEntry,
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
