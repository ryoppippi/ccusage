import * as v from 'valibot';
import { logger } from './logger.ts';

const ModelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
});

export type ModelPricing = v.InferOutput<typeof ModelPricingSchema>;

const LITELLM_PRICING_URL
	= 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

let cachedPricing: Record<string, ModelPricing> | null = null;

// Export for testing purposes
export function clearPricingCache(): void {
	cachedPricing = null;
}

export async function fetchModelPricing(): Promise<
	Record<string, ModelPricing>
> {
	if (cachedPricing != null) {
		return cachedPricing;
	}

	try {
		logger.warn('Fetching latest model pricing from LiteLLM...');
		const response = await fetch(LITELLM_PRICING_URL);
		if (!response.ok) {
			throw new Error(`Failed to fetch pricing data: ${response.statusText}`);
		}

		const data = await response.json();
		const pricing: Record<string, ModelPricing> = {};

		for (const [modelName, modelData] of Object.entries(
			data as Record<string, unknown>,
		)) {
			if (typeof modelData === 'object' && modelData !== null) {
				try {
					const parsed = v.parse(ModelPricingSchema, modelData);
					pricing[modelName] = parsed;
				}
				catch {
					// Skip models that don't match our schema
				}
			}
		}

		cachedPricing = pricing;
		logger.info(`Loaded pricing for ${Object.keys(pricing).length} models`);
		return pricing;
	}
	catch (error) {
		logger.error('Failed to fetch model pricing:', error);
		throw new Error('Could not fetch model pricing data');
	}
}

export function getModelPricing(
	modelName: string,
	pricing: Record<string, ModelPricing>,
): ModelPricing | null {
	// Direct match
	if (pricing[modelName] != null) {
		return pricing[modelName];
	}

	// Try with provider prefix variations
	const variations = [
		modelName,
		`anthropic/${modelName}`,
		`claude-3-5-${modelName}`,
		`claude-3-${modelName}`,
		`claude-${modelName}`,
	];

	for (const variant of variations) {
		if (pricing[variant] != null) {
			return pricing[variant];
		}
	}

	// Try to find partial matches (e.g., "gpt-4" might match "gpt-4-0125-preview")
	const lowerModel = modelName.toLowerCase();
	for (const [key, value] of Object.entries(pricing)) {
		if (
			key.toLowerCase().includes(lowerModel)
			|| lowerModel.includes(key.toLowerCase())
		) {
			return value;
		}
	}

	return null;
}

export function calculateCostFromTokens(
	tokens: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	},
	pricing: ModelPricing,
): number {
	let cost = 0;

	// Input tokens cost
	if (pricing.input_cost_per_token != null) {
		cost += tokens.input_tokens * pricing.input_cost_per_token;
	}

	// Output tokens cost
	if (pricing.output_cost_per_token != null) {
		cost += tokens.output_tokens * pricing.output_cost_per_token;
	}

	// Cache creation tokens cost
	if (
		tokens.cache_creation_input_tokens != null
		&& pricing.cache_creation_input_token_cost != null
	) {
		cost
			+= tokens.cache_creation_input_tokens
				* pricing.cache_creation_input_token_cost;
	}

	// Cache read tokens cost
	if (tokens.cache_read_input_tokens != null && pricing.cache_read_input_token_cost != null) {
		cost
			+= tokens.cache_read_input_tokens * pricing.cache_read_input_token_cost;
	}

	return cost;
}
