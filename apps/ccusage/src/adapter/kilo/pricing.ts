import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { KiloUsageEntry } from './schema.ts';
import { Result } from '@praha/byethrow';

function normalizeKiloProviderID(providerID: string): string {
	return providerID.replaceAll('-', '_');
}

function createModelCandidates(entry: KiloUsageEntry): string[] {
	const candidates = [entry.model];
	if (entry.providerID !== 'unknown' && entry.providerID !== 'kilo') {
		candidates.push(`${normalizeKiloProviderID(entry.providerID)}/${entry.model}`);
	}
	return Array.from(new Set(candidates));
}

export async function calculateKiloCost(
	entry: KiloUsageEntry,
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
