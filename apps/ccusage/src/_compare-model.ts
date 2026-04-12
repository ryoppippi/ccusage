import { Result } from '@praha/byethrow';
import { PricingFetcher } from './_pricing-fetcher.ts';

type TokenData = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};

/**
 * Augments usage data rows with comparison costs using a different model's pricing.
 * When compareModel is undefined, returns data unchanged.
 * When compareModel is provided, calculates what the same tokens would cost with that model.
 */
export async function withComparisonCosts<T extends TokenData>(
	data: T[],
	compareModel: string | undefined,
	offline?: boolean,
): Promise<(T & { comparisonCost?: number; comparisonModelName?: string })[]> {
	if (compareModel == null) {
		return data;
	}

	using fetcher = new PricingFetcher(offline);
	return await Promise.all(
		data.map(async (item) => {
			const comparisonCost = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: item.inputTokens,
						output_tokens: item.outputTokens,
						cache_creation_input_tokens: item.cacheCreationTokens,
						cache_read_input_tokens: item.cacheReadTokens,
					},
					compareModel,
				),
				0,
			);
			return { ...item, comparisonCost, comparisonModelName: compareModel };
		}),
	);
}
