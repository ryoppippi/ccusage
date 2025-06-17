import * as v from 'valibot';
import { LITELLM_PRICING_URL } from './consts.internal.ts';
import { logger } from './logger.ts';
import { prefetchClaudePricing } from './macro.internal.ts' with { type: 'macro' };
import { type ModelPricing, ModelPricingSchema } from './types.internal.ts';

/**
 * Fetches and caches model pricing information from LiteLLM
 * Implements Disposable pattern for automatic resource cleanup
 */
export class PricingFetcher implements Disposable {
	private cachedPricing: Map<string, ModelPricing> | null = null;
	private readonly offline: boolean;

	/**
	 * Creates a new PricingFetcher instance
	 * @param offline - Whether to use pre-fetched pricing data instead of fetching from API
	 */
	constructor(offline = false) {
		this.offline = offline;
	}

	/**
	 * Implements Disposable interface for automatic cleanup
	 */
	[Symbol.dispose](): void {
		this.clearCache();
	}

	/**
	 * Clears the cached pricing data
	 */
	clearCache(): void {
		this.cachedPricing = null;
	}

	/**
	 * Ensures pricing data is loaded, either from cache or by fetching
	 * @returns Map of model names to pricing information
	 */
	private async ensurePricingLoaded(): Promise<Map<string, ModelPricing>> {
		if (this.cachedPricing != null) {
			return this.cachedPricing;
		}

		// If we're in offline mode, return pre-fetched data
		if (this.offline) {
			const pricing = new Map(Object.entries(await prefetchClaudePricing()));
			this.cachedPricing = pricing;
			return pricing;
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

	/**
	 * Fetches all available model pricing data
	 * @returns Map of model names to pricing information
	 */
	async fetchModelPricing(): Promise<Map<string, ModelPricing>> {
		return this.ensurePricingLoaded();
	}

	/**
	 * Gets pricing information for a specific model with fallback matching
	 * Tries exact match first, then provider prefixes, then partial matches
	 * @param modelName - Name of the model to get pricing for
	 * @returns Model pricing information or null if not found
	 */
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

	/**
	 * Calculates the cost for given token usage and model
	 * @param tokens - Token usage breakdown
	 * @param tokens.input_tokens - Number of input tokens
	 * @param tokens.output_tokens - Number of output tokens
	 * @param tokens.cache_creation_input_tokens - Number of cache creation tokens
	 * @param tokens.cache_read_input_tokens - Number of cache read tokens
	 * @param modelName - Name of the model used
	 * @returns Total cost in USD
	 */
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

	/**
	 * Calculates cost from token usage and pricing information
	 * @param tokens - Token usage breakdown
	 * @param tokens.input_tokens - Number of input tokens
	 * @param tokens.output_tokens - Number of output tokens
	 * @param tokens.cache_creation_input_tokens - Number of cache creation tokens
	 * @param tokens.cache_read_input_tokens - Number of cache read tokens
	 * @param pricing - Model pricing rates
	 * @returns Total cost in USD
	 */
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
