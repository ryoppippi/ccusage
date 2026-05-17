import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { KimiUsageEntry } from './schema.ts';
import { Result } from '@praha/byethrow';

function createKimiModelCandidates(entry: KimiUsageEntry): string[] {
	return Array.from(
		new Set([entry.model, `${entry.provider}/${entry.model}`, `kimi/${entry.model}`]),
	);
}

export async function calculateKimiCost(
	entry: KimiUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	const tokens = {
		input_tokens: entry.inputTokens,
		output_tokens: entry.outputTokens,
		cache_creation_input_tokens: entry.cacheCreationTokens,
		cache_read_input_tokens: entry.cacheReadTokens,
	};

	for (const candidate of createKimiModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}
