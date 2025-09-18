import { Result } from '@praha/byethrow';
import * as v from 'valibot';

export const LITELLM_PRICING_URL
	= 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const liteLLMModelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
	max_tokens: v.optional(v.number()),
	max_input_tokens: v.optional(v.number()),
	max_output_tokens: v.optional(v.number()),
	// 1M context window pricing
	input_cost_per_token_above_200k_tokens: v.optional(v.number()),
	output_cost_per_token_above_200k_tokens: v.optional(v.number()),
	cache_creation_input_token_cost_above_200k_tokens: v.optional(v.number()),
	cache_read_input_token_cost_above_200k_tokens: v.optional(v.number()),
});

export type LiteLLMModelPricing = v.InferOutput<typeof liteLLMModelPricingSchema>;

export type PricingLogger = {
	debug: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
};

export type LiteLLMPricingFetcherOptions = {
	logger?: PricingLogger;
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
	url?: string;
	providerPrefixes?: string[];
};

const DEFAULT_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openai/',
	'azure/',
	'openrouter/openai/',
];

function createLogger(logger?: PricingLogger): PricingLogger {
	if (logger != null) {
		return logger;
	}

	return {
		debug: () => {},
		error: () => {},
		info: () => {},
		warn: () => {},
	};
}

export class LiteLLMPricingFetcher implements Disposable {
	private cachedPricing: Map<string, LiteLLMModelPricing> | null = null;
	private readonly logger: PricingLogger;
	private readonly offline: boolean;
	private readonly offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
	private readonly url: string;
	private readonly providerPrefixes: string[];

	constructor(options: LiteLLMPricingFetcherOptions = {}) {
		this.logger = createLogger(options.logger);
		this.offline = Boolean(options.offline);
		this.offlineLoader = options.offlineLoader;
		this.url = options.url ?? LITELLM_PRICING_URL;
		this.providerPrefixes = options.providerPrefixes ?? DEFAULT_PROVIDER_PREFIXES;
	}

	[Symbol.dispose](): void {
		this.clearCache();
	}

	clearCache(): void {
		this.cachedPricing = null;
	}

	private loadOfflinePricing = Result.try({
		try: async () => {
			if (this.offlineLoader == null) {
				throw new Error('Offline loader was not provided');
			}

			const pricing = new Map(Object.entries(await this.offlineLoader()));
			this.cachedPricing = pricing;
			return pricing;
		},
		catch: error => new Error('Failed to load offline pricing data', { cause: error }),
	});

	private async handleFallbackToCachedPricing(originalError: unknown): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		this.logger.warn('Failed to fetch model pricing from LiteLLM, falling back to cached pricing data');
		this.logger.debug('Fetch error details:', originalError);
		return Result.pipe(
			this.loadOfflinePricing(),
			Result.inspect((pricing) => {
				this.logger.info(`Using cached pricing data for ${pricing.size} models`);
			}),
			Result.inspectError((error) => {
				this.logger.error('Failed to load cached pricing data as fallback:', error);
				this.logger.error('Original fetch error:', originalError);
			}),
		);
	}

	private async ensurePricingLoaded(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		return Result.pipe(
			this.cachedPricing != null ? Result.succeed(this.cachedPricing) : Result.fail(new Error('Cached pricing not available')),
			Result.orElse(async () => {
				if (this.offline) {
					return this.loadOfflinePricing();
				}

				this.logger.warn('Fetching latest model pricing from LiteLLM...');
				return Result.pipe(
					Result.try({
						try: fetch(this.url),
						catch: error => new Error('Failed to fetch model pricing from LiteLLM', { cause: error }),
					}),
					Result.andThrough((response) => {
						if (!response.ok) {
							return Result.fail(new Error(`Failed to fetch pricing data: ${response.statusText}`));
						}
						return Result.succeed();
					}),
					Result.andThen(async response => Result.try({
						try: response.json() as Promise<Record<string, unknown>>,
						catch: error => new Error('Failed to parse pricing data', { cause: error }),
					})),
					Result.map((data) => {
						const pricing = new Map<string, LiteLLMModelPricing>();
						for (const [modelName, modelData] of Object.entries(data)) {
							if (typeof modelData !== 'object' || modelData == null) {
								continue;
							}

							const parsed = v.safeParse(liteLLMModelPricingSchema, modelData);
							if (!parsed.success) {
								continue;
							}

							pricing.set(modelName, parsed.output);
						}
						return pricing;
					}),
					Result.inspect((pricing) => {
						this.cachedPricing = pricing;
						this.logger.info(`Loaded pricing for ${pricing.size} models`);
					}),
					Result.orElse(async error => this.handleFallbackToCachedPricing(error)),
				);
			}),
		);
	}

	async fetchModelPricing(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		return this.ensurePricingLoaded();
	}

	private createMatchingCandidates(modelName: string): string[] {
		const candidates = new Set<string>();
		candidates.add(modelName);

		for (const prefix of this.providerPrefixes) {
			candidates.add(`${prefix}${modelName}`);
		}

		return Array.from(candidates);
	}

	async getModelPricing(modelName: string): Result.ResultAsync<LiteLLMModelPricing | null, Error> {
		return Result.pipe(
			this.ensurePricingLoaded(),
			Result.map((pricing) => {
				for (const candidate of this.createMatchingCandidates(modelName)) {
					const direct = pricing.get(candidate);
					if (direct != null) {
						return direct;
					}
				}

				const lower = modelName.toLowerCase();
				for (const [key, value] of pricing) {
					const comparison = key.toLowerCase();
					if (comparison.includes(lower) || lower.includes(comparison)) {
						return value;
					}
				}

				return null;
			}),
		);
	}

	async getModelContextLimit(modelName: string): Result.ResultAsync<number | null, Error> {
		return Result.pipe(
			this.getModelPricing(modelName),
			Result.map(pricing => pricing?.max_input_tokens ?? null),
		);
	}

	calculateCostFromPricing(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		pricing: LiteLLMModelPricing,
	): number {
		let cost = 0;
		const CONTEXT_THRESHOLD = 200_000;

		// Calculate input tokens cost
		if (tokens.input_tokens > 0) {
			if (tokens.input_tokens > CONTEXT_THRESHOLD && pricing.input_cost_per_token_above_200k_tokens != null) {
				// Split tokens into two buckets: below and above 200k
				const tokensBelow200k = Math.min(tokens.input_tokens, CONTEXT_THRESHOLD);
				const tokensAbove200k = Math.max(0, tokens.input_tokens - CONTEXT_THRESHOLD);

				if (pricing.input_cost_per_token != null) {
					cost += tokensBelow200k * pricing.input_cost_per_token;
				}
				cost += tokensAbove200k * pricing.input_cost_per_token_above_200k_tokens;
			}
			else if (pricing.input_cost_per_token != null) {
				cost += tokens.input_tokens * pricing.input_cost_per_token;
			}
		}

		// Calculate output tokens cost
		if (tokens.output_tokens > 0) {
			if (tokens.output_tokens > CONTEXT_THRESHOLD && pricing.output_cost_per_token_above_200k_tokens != null) {
				// Split tokens into two buckets: below and above 200k
				const tokensBelow200k = Math.min(tokens.output_tokens, CONTEXT_THRESHOLD);
				const tokensAbove200k = Math.max(0, tokens.output_tokens - CONTEXT_THRESHOLD);

				if (pricing.output_cost_per_token != null) {
					cost += tokensBelow200k * pricing.output_cost_per_token;
				}
				cost += tokensAbove200k * pricing.output_cost_per_token_above_200k_tokens;
			}
			else if (pricing.output_cost_per_token != null) {
				cost += tokens.output_tokens * pricing.output_cost_per_token;
			}
		}

		// Calculate cache creation cost
		if (tokens.cache_creation_input_tokens != null && tokens.cache_creation_input_tokens > 0) {
			if (tokens.cache_creation_input_tokens > CONTEXT_THRESHOLD && pricing.cache_creation_input_token_cost_above_200k_tokens != null) {
				const tokensBelow200k = Math.min(tokens.cache_creation_input_tokens, CONTEXT_THRESHOLD);
				const tokensAbove200k = Math.max(0, tokens.cache_creation_input_tokens - CONTEXT_THRESHOLD);

				if (pricing.cache_creation_input_token_cost != null) {
					cost += tokensBelow200k * pricing.cache_creation_input_token_cost;
				}
				cost += tokensAbove200k * pricing.cache_creation_input_token_cost_above_200k_tokens;
			}
			else if (pricing.cache_creation_input_token_cost != null) {
				cost += tokens.cache_creation_input_tokens * pricing.cache_creation_input_token_cost;
			}
		}

		// Calculate cache read cost
		if (tokens.cache_read_input_tokens != null && tokens.cache_read_input_tokens > 0) {
			if (tokens.cache_read_input_tokens > CONTEXT_THRESHOLD && pricing.cache_read_input_token_cost_above_200k_tokens != null) {
				const tokensBelow200k = Math.min(tokens.cache_read_input_tokens, CONTEXT_THRESHOLD);
				const tokensAbove200k = Math.max(0, tokens.cache_read_input_tokens - CONTEXT_THRESHOLD);

				if (pricing.cache_read_input_token_cost != null) {
					cost += tokensBelow200k * pricing.cache_read_input_token_cost;
				}
				cost += tokensAbove200k * pricing.cache_read_input_token_cost_above_200k_tokens;
			}
			else if (pricing.cache_read_input_token_cost != null) {
				cost += tokens.cache_read_input_tokens * pricing.cache_read_input_token_cost;
			}
		}

		return cost;
	}

	async calculateCostFromTokens(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		modelName?: string,
	): Result.ResultAsync<number, Error> {
		if (modelName == null || modelName === '') {
			return Result.succeed(0);
		}

		return Result.pipe(
			this.getModelPricing(modelName),
			Result.andThen((pricing) => {
				if (pricing == null) {
					return Result.fail(new Error(`Model pricing not found for ${modelName}`));
				}
				return Result.succeed(
					this.calculateCostFromPricing(tokens, pricing),
				);
			}),
		);
	}
}

if (import.meta.vitest != null) {
	describe('LiteLLMPricingFetcher', () => {
		it('returns pricing data from LiteLLM dataset', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBe(1);
		});

		it('calculates cost using pricing information', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 200,
			}, 'gpt-5'));

			expect(cost).toBeCloseTo((1000 * 1.25e-6) + (500 * 1e-5) + (200 * 1.25e-7));
		});

		it('calculates cost with 1M context window pricing for input tokens', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						output_cost_per_token: 1.5e-5,
						input_cost_per_token_above_200k_tokens: 6e-6,
						output_cost_per_token_above_200k_tokens: 2.25e-5,
					},
				}),
			});

			// Test with 300k input tokens (200k at normal rate, 100k at higher rate)
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 300_000,
				output_tokens: 1000,
			}, 'claude-4-sonnet-20250514'));

			const expectedCost = (200_000 * 3e-6) + (100_000 * 6e-6) + (1000 * 1.5e-5);
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('calculates cost with 1M context window pricing for output tokens', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						output_cost_per_token: 1.5e-5,
						input_cost_per_token_above_200k_tokens: 6e-6,
						output_cost_per_token_above_200k_tokens: 2.25e-5,
					},
				}),
			});

			// Test with 250k output tokens (200k at normal rate, 50k at higher rate)
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 1000,
				output_tokens: 250_000,
			}, 'claude-4-sonnet-20250514'));

			const expectedCost = (1000 * 3e-6) + (200_000 * 1.5e-5) + (50_000 * 2.25e-5);
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('calculates cost with 1M context window pricing for cache tokens', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						cache_creation_input_token_cost: 3.75e-6,
						cache_read_input_token_cost: 3e-7,
						cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
						cache_read_input_token_cost_above_200k_tokens: 6e-7,
					},
				}),
			});

			// Test with 300k cache creation and read tokens
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 1000,
				output_tokens: 0,
				cache_creation_input_tokens: 300_000,
				cache_read_input_tokens: 250_000,
			}, 'claude-4-sonnet-20250514'));

			const expectedCost = (1000 * 3e-6)
				+ (200_000 * 3.75e-6) + (100_000 * 7.5e-6) // cache creation
				+ (200_000 * 3e-7) + (50_000 * 6e-7); // cache read
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('handles models without 1M context pricing correctly', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			// Should use normal pricing for all tokens
			const cost = await Result.unwrap(fetcher.calculateCostFromTokens({
				input_tokens: 300_000,
				output_tokens: 250_000,
			}, 'gpt-5'));

			expect(cost).toBeCloseTo((300_000 * 1e-6) + (250_000 * 2e-6));
		});
	});
}
