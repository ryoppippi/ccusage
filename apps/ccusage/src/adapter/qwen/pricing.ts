import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { QwenUsageEntry } from './types.ts';
import { Result } from '@praha/byethrow';

function createQwenModelCandidates(entry: QwenUsageEntry): string[] {
	return Array.from(
		new Set([entry.model, `${entry.provider}/${entry.model}`, `alibaba/${entry.model}`]),
	);
}

export async function calculateQwenCost(
	entry: QwenUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	const tokens = {
		input_tokens: entry.inputTokens,
		output_tokens: entry.outputTokens + entry.reasoningTokens,
		cache_creation_input_tokens: entry.cacheCreationTokens,
		cache_read_input_tokens: entry.cacheReadTokens,
	};

	for (const candidate of createQwenModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}
