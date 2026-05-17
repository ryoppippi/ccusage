import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { HermesUsageEntry } from './parser.ts';
import { Result } from '@praha/byethrow';

function createModelCandidates(entry: HermesUsageEntry): string[] {
	const candidates = [entry.model];
	if (entry.provider !== 'hermes') {
		candidates.push(`${entry.provider}/${entry.model}`);
	}
	return Array.from(new Set(candidates));
}

export async function calculateHermesCost(
	entry: HermesUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	if (entry.costUSD > 0) {
		return entry.costUSD;
	}

	const tokens = {
		input_tokens: entry.inputTokens,
		output_tokens: entry.outputTokens + entry.reasoningTokens,
		cache_creation_input_tokens: entry.cacheCreationTokens,
		cache_read_input_tokens: entry.cacheReadTokens,
	};

	for (const candidate of createModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}
