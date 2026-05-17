import type { LiteLLMModelPricing } from './pricing.ts';
import { Result } from '@praha/byethrow';
import { LITELLM_PRICING_URL, liteLLMModelPricingSchema } from './pricing.ts';

export type PricingDataset = Record<string, LiteLLMModelPricing>;

export function createPricingDataset(): PricingDataset {
	return Object.create(null) as PricingDataset;
}

export async function fetchLiteLLMPricingDataset(): Promise<PricingDataset> {
	const response = await fetch(LITELLM_PRICING_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch pricing data: ${response.status} ${response.statusText}`);
	}

	const rawDataset = (await response.json()) as Record<string, unknown>;
	const dataset = createPricingDataset();

	for (const [modelName, modelData] of Object.entries(rawDataset)) {
		if (modelData == null || typeof modelData !== 'object') {
			continue;
		}

		const parsed = Result.parse(liteLLMModelPricingSchema, modelData);
		if (Result.isFailure(parsed)) {
			continue;
		}

		dataset[modelName] = parsed.value;
	}

	return dataset;
}

export function filterPricingDataset(
	dataset: PricingDataset,
	predicate: (modelName: string, pricing: LiteLLMModelPricing) => boolean,
): PricingDataset {
	const filtered = createPricingDataset();
	for (const [modelName, pricing] of Object.entries(dataset)) {
		if (predicate(modelName, pricing)) {
			filtered[modelName] = pricing;
		}
	}
	return filtered;
}
