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

export class PricingFetcher implements Disposable {
	private cachedPricing: Map<string, ModelPricing> | null = null;

	constructor() {}

	[Symbol.dispose](): void {
		this.clearCache();
	}

	clearCache(): void {
		this.cachedPricing = null;
	}

	private async ensurePricingLoaded(): Promise<Map<string, ModelPricing>> {
		if (this.cachedPricing != null) {
			return this.cachedPricing;
		}

		try {
			logger.warn('Fetching latest model pricing from LiteLLM...');
			const response = await fetch(LITELLM_PRICING_URL);
			if (!response.ok) {
				throw new Error(`Failed to fetch pricing data: ${response.statusText}`);
			}

			const data = await response.json();
			const pricing = new Map<string, ModelPricing>();

			for (const [modelName, modelData] of Object.entries(
				data as Record<string, unknown>,
			)) {
				if (typeof modelData === 'object' && modelData !== null) {
					const parsed = v.safeParse(ModelPricingSchema, modelData);
					if (parsed.success) {
						pricing.set(modelName, parsed.output);
					}
					// Skip models that don't match our schema
				}
			}

			this.cachedPricing = pricing;
			logger.info(`Loaded pricing for ${pricing.size} models`);
			return pricing;
		}
		catch (error) {
			logger.error('Failed to fetch model pricing:', error);
			throw new Error('Could not fetch model pricing data');
		}
	}

	async fetchModelPricing(): Promise<Map<string, ModelPricing>> {
		return this.ensurePricingLoaded();
	}

	async getModelPricing(
		modelName: string,
	): Promise<ModelPricing | null> {
		const pricing = await this.ensurePricingLoaded();
		// Direct match
		const directMatch = pricing.get(modelName);
		if (directMatch != null) {
			return directMatch;
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
			const match = pricing.get(variant);
			if (match != null) {
				return match;
			}
		}

		// Try to find partial matches (e.g., "gpt-4" might match "gpt-4-0125-preview")
		const lowerModel = modelName.toLowerCase();
		for (const [key, value] of pricing) {
			if (
				key.toLowerCase().includes(lowerModel)
				|| lowerModel.includes(key.toLowerCase())
			) {
				return value;
			}
		}

		return null;
	}

	async calculateCostFromTokens(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		modelName: string,
	): Promise<number> {
		const pricing = await this.getModelPricing(modelName);
		if (pricing == null) {
			return 0;
		}
		return this.calculateCostFromPricing(tokens, pricing);
	}

	calculateCostFromPricing(
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
}
