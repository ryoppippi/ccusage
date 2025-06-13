import { readFile } from 'node:fs/promises';
import * as v from 'valibot';
import { logger } from './logger.ts';

const ModelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
});

export type ModelPricing = v.InferOutput<typeof ModelPricingSchema>;

export class PricingSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PricingSourceError';
	}
}

const LITELLM_PRICING_URL
	= 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export class PricingFetcher implements Disposable {
	private cachedPricing: Map<string, ModelPricing> | null = null;
	private pricingSource: string;
	private isCustomSource: boolean;

	constructor(pricingSource?: string) {
		this.pricingSource = pricingSource ?? LITELLM_PRICING_URL;
		this.isCustomSource = pricingSource != null;
	}

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
			let data: unknown;
			const isUrl = this.pricingSource.startsWith('https://');

			if (isUrl) {
				logger.warn(`Fetching model pricing from URL: ${this.pricingSource}`);
				const response = await fetch(this.pricingSource);
				if (!response.ok) {
					throw new Error(`Failed to fetch pricing data: ${response.statusText}`);
				}
				data = await response.json();
			}
			else {
				logger.warn(`Loading model pricing from local file: ${this.pricingSource}`);
				const fileContent = await readFile(this.pricingSource, 'utf-8');
				data = JSON.parse(fileContent) as unknown;
			}

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
			logger.info(`Loaded pricing for ${pricing.size} models from ${isUrl ? 'URL' : 'local file'}`);
			return pricing;
		}
		catch (error) {
			logger.error('Failed to fetch model pricing:', error);

			// For custom sources, throw the error to fail gracefully
			if (this.isCustomSource) {
				throw new PricingSourceError(`Failed to load custom pricing data from '${this.pricingSource}': ${error instanceof Error ? error.message : String(error)}`);
			}

			// For default LiteLLM URL, cache empty map to prevent retrying
			this.cachedPricing = new Map<string, ModelPricing>();
			return this.cachedPricing;
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
