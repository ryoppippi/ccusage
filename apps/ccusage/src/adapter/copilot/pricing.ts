import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { CopilotUsageEntry } from './parser.ts';
import { Result } from '@praha/byethrow';

export async function calculateCopilotCost(
	entry: CopilotUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	const result = await fetcher.calculateCostFromTokens(
		{
			input_tokens: entry.inputTokens,
			output_tokens: entry.outputTokens + entry.reasoningOutputTokens,
			cache_creation_input_tokens: entry.cacheCreationTokens,
			cache_read_input_tokens: entry.cacheReadTokens,
		},
		entry.model,
	);
	return Result.isSuccess(result) ? result.value : 0;
}
