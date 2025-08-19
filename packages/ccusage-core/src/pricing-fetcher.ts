/**
 * @fileoverview Model pricing data fetcher for cost calculations
 *
 * This module provides a PricingFetcher class that retrieves and caches
 * model pricing information from LiteLLM's pricing database for accurate
 * cost calculations based on token usage.
 *
 * @module pricing-fetcher
 */

import type { ModelPricing } from './_types.ts';
import { Result } from '@praha/byethrow';
import { LITELLM_PRICING_URL } from './_consts.ts';
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };
import { modelPricingSchema } from './_types.ts';
import { logger } from './logger.ts';

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
	 * Loads offline pricing data from pre-fetched cache
	 * @returns Map of model names to pricing information
	 */
	private loadOfflinePricing = Result.try({
		try: async () => {
			const pricing = new Map(Object.entries(await prefetchClaudePricing()));
			this.cachedPricing = pricing;
			return pricing;
		},
		catch: error => new Error('Failed to load offline pricing data', { cause: error }),
	});

	/**
	 * Handles fallback to offline pricing when network fetch fails
	 * @param originalError - The original error from the network fetch
	 * @returns Map of model names to pricing information
	 * @throws Error if both network fetch and fallback fail
	 */
	private async handleFallbackToCachedPricing(originalError: unknown): Result.ResultAsync<Map<string, ModelPricing>, Error> {
		logger.warn('Failed to fetch model pricing from LiteLLM, falling back to cached pricing data');
		logger.debug('Fetch error details:', originalError);
		return Result.pipe(
			this.loadOfflinePricing(),
			Result.inspect((pricing) => {
				logger.info(`Using cached pricing data for ${pricing.size} models`);
			}),
			Result.inspectError((error) => {
				logger.error('Failed to load cached pricing data as fallback:', error);
				logger.error('Original fetch error:', originalError);
			}),
		);
	}

	/**
	 * Ensures pricing data is loaded, either from cache or by fetching
	 * Automatically falls back to offline mode if network fetch fails
	 * @returns Map of model names to pricing information
	 */
	private async ensurePricingLoaded(): Result.ResultAsync<Map<string, ModelPricing>, Error> {
		return Result.pipe(
			this.cachedPricing != null ? Result.succeed(this.cachedPricing) : Result.fail(new Error('Cached pricing not available')),
			Result.orElse(async () => {
				// If we're in offline mode, return pre-fetched data
				if (this.offline) {
					return this.loadOfflinePricing();
				}

				logger.warn('Fetching latest model pricing from LiteLLM...');
				return Result.pipe(
					Result.try({
						try: fetch(LITELLM_PRICING_URL),
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
						const pricing = new Map<string, ModelPricing>();
						for (const [modelName, modelData] of Object.entries(data)) {
							if (typeof modelData === 'object' && modelData !== null) {
								const parsed = modelPricingSchema.safeParse(modelData);
								if (parsed.success) {
									pricing.set(modelName, parsed.data);
								}
								// Skip models that don't match our schema
							}
						}
						return pricing;
					}),
					Result.inspect((pricing) => {
						this.cachedPricing = pricing;
						logger.info(`Loaded pricing for ${pricing.size} models`);
					}),
					Result.orElse(async error => this.handleFallbackToCachedPricing(error)),
				);
			}),
		);
	}

	/**
	 * Fetches all available model pricing data
	 * @returns Map of model names to pricing information
	 */
	async fetchModelPricing(): Result.ResultAsync<Map<string, ModelPricing>, Error> {
		return this.ensurePricingLoaded();
	}

	/**
	 * Gets pricing information for a specific model with fallback matching
	 * Tries exact match first, then provider prefixes, then partial matches
	 * @param modelName - Name of the model to get pricing for
	 * @returns Model pricing information or null if not found
	 */
	async getModelPricing(modelName: string): Result.ResultAsync<ModelPricing | null, Error> {
		return Result.pipe(
			this.ensurePricingLoaded(),
			Result.map((pricing) => {
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
			}),
		);
	}

	/**
	 * Gets context window limit for a specific model from LiteLLM data
	 * @param modelName - The model name to get context limit for
	 * @returns The context limit in tokens, or null if not found
	 */
	async getModelContextLimit(modelName: string): Result.ResultAsync<number | null, Error> {
		return Result.pipe(
			this.getModelPricing(modelName),
			Result.map((pricing) => {
				if (pricing == null) {
					return null; // Model not found in LiteLLM pricing data
				}

				const contextLimit = pricing.max_input_tokens ?? pricing.max_tokens;
				if (contextLimit == null) {
					return null; // No context limit data available for model
				}

				return contextLimit;
			}),
		);
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
	): Result.ResultAsync<number, Error> {
		return Result.pipe(
			this.getModelPricing(modelName),
			Result.map(pricing => pricing == null ? 0 : this.calculateCostFromPricing(tokens, pricing)),
		);
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

if (import.meta.vitest != null) {
	describe('pricing-fetcher', () => {
		describe('pricingFetcher class', () => {
			it('should support using statement for automatic cleanup', async () => {
				let fetcherDisposed = false;

				class TestPricingFetcher extends PricingFetcher {
					override [Symbol.dispose](): void {
						super[Symbol.dispose]();
						fetcherDisposed = true;
					}
				}

				{
					using fetcher = new TestPricingFetcher();
					const pricing = await Result.unwrap(fetcher.fetchModelPricing());
					expect(pricing.size).toBeGreaterThan(0);
				}

				expect(fetcherDisposed).toBe(true);
			});

			it('should calculate costs directly with model name', async () => {
				using fetcher = new PricingFetcher();

				const cost = await Result.unwrap(fetcher.calculateCostFromTokens(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					'claude-4-sonnet-20250514',
				));

				expect(cost).toBeGreaterThan(0);
			});
		});

		describe('fetchModelPricing', () => {
			it('should fetch and parse pricing data from LiteLLM', async () => {
				using fetcher = new PricingFetcher();
				const pricing = await Result.unwrap(fetcher.fetchModelPricing());

				// Should have pricing data
				expect(pricing.size).toBeGreaterThan(0);

				// Check for Claude models
				const claudeModels = Array.from(pricing.keys()).filter(model =>
					model.toLowerCase().includes('claude'),
				);
				expect(claudeModels.length).toBeGreaterThan(0);
			});

			it('should cache pricing data', async () => {
				using fetcher = new PricingFetcher();
				// First call should fetch from network
				const firstResult = await Result.unwrap(fetcher.fetchModelPricing());
				const firstKeys = Array.from(firstResult.keys());

				// Second call should use cache (and be instant)
				const startTime = Date.now();
				const secondResult = await Result.unwrap(fetcher.fetchModelPricing());
				const endTime = Date.now();

				// Should be very fast (< 5ms) if cached
				expect(endTime - startTime).toBeLessThan(5);

				// Should have same data
				expect(Array.from(secondResult.keys())).toEqual(firstKeys);
			});
		});

		describe('getModelPricing', () => {
			it('should find models by exact match', async () => {
				using fetcher = new PricingFetcher();

				// Test with a known Claude model from LiteLLM
				const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-20250514'));
				expect(pricing).not.toBeNull();
			});

			it('should find models with partial matches', async () => {
				using fetcher = new PricingFetcher();

				// Test partial matching
				const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4'));
				expect(pricing).not.toBeNull();
			});

			it('should return null for unknown models', async () => {
				using fetcher = new PricingFetcher();

				const pricing = await Result.unwrap(fetcher.getModelPricing(
					'definitely-not-a-real-model-xyz',
				));
				expect(pricing).toBeNull();
			});
		});

		describe('calculateCostFromTokens', () => {
			it('should calculate cost for claude-sonnet-4-20250514', async () => {
				using fetcher = new PricingFetcher();
				const modelName = 'claude-4-sonnet-20250514';
				const pricing = await Result.unwrap(fetcher.getModelPricing(modelName));

				// This model should exist in LiteLLM
				expect(pricing).not.toBeNull();
				expect(pricing?.input_cost_per_token).not.toBeUndefined();
				expect(pricing?.output_cost_per_token).not.toBeUndefined();

				const cost = fetcher.calculateCostFromPricing(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					pricing!,
				);

				expect(cost).toBeGreaterThan(0);
			});

			it('should calculate cost including cache tokens for claude-sonnet-4-20250514', async () => {
				using fetcher = new PricingFetcher();
				const modelName = 'claude-4-sonnet-20250514';
				const pricing = await Result.unwrap(fetcher.getModelPricing(modelName));

				// We need to check that pricing is not null before using it
				expect(pricing).not.toBeNull();
				const cost = fetcher.calculateCostFromPricing(
					{
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 200,
						cache_read_input_tokens: 300,
					},
					pricing!,
				);

				const expectedCost
				= 1000 * (pricing!.input_cost_per_token ?? 0)
					+ 500 * (pricing!.output_cost_per_token ?? 0)
					+ 200 * (pricing!.cache_creation_input_token_cost ?? 0)
					+ 300 * (pricing!.cache_read_input_token_cost ?? 0);

				expect(cost).toBeCloseTo(expectedCost);
				expect(cost).toBeGreaterThan(0);
			});

			it('should calculate cost for claude-opus-4-20250514', async () => {
				using fetcher = new PricingFetcher();
				const modelName = 'claude-4-opus-20250514';
				const pricing = await Result.unwrap(fetcher.getModelPricing(modelName));

				// This model should exist in LiteLLM
				expect(pricing).not.toBeNull();
				expect(pricing?.input_cost_per_token).not.toBeUndefined();
				expect(pricing?.output_cost_per_token).not.toBeUndefined();

				const cost = fetcher.calculateCostFromPricing(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					pricing!,
				);

				expect(cost).toBeGreaterThan(0);
			});

			it('should calculate cost including cache tokens for claude-opus-4-20250514', async () => {
				using fetcher = new PricingFetcher();
				const modelName = 'claude-4-opus-20250514';
				const pricing = await Result.unwrap(fetcher.getModelPricing(modelName));

				// We need to check that pricing is not null before using it
				expect(pricing).not.toBeNull();
				const cost = fetcher.calculateCostFromPricing(
					{
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 200,
						cache_read_input_tokens: 300,
					},
					pricing!,
				);

				const expectedCost
				= 1000 * (pricing!.input_cost_per_token ?? 0)
					+ 500 * (pricing!.output_cost_per_token ?? 0)
					+ 200 * (pricing!.cache_creation_input_token_cost ?? 0)
					+ 300 * (pricing!.cache_read_input_token_cost ?? 0);

				expect(cost).toBeCloseTo(expectedCost);
				expect(cost).toBeGreaterThan(0);
			});

			it('should handle missing pricing fields', () => {
				using fetcher = new PricingFetcher();
				const partialPricing: ModelPricing = {
					input_cost_per_token: 0.00001,
				// output_cost_per_token is missing
				};

				const cost = fetcher.calculateCostFromPricing(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					partialPricing,
				);

				// Should only calculate input cost
				expect(cost).toBeCloseTo(1000 * 0.00001);
			});

			it('should return 0 for empty pricing', () => {
				using fetcher = new PricingFetcher();
				const emptyPricing: ModelPricing = {};

				const cost = fetcher.calculateCostFromPricing(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					emptyPricing,
				);

				expect(cost).toBe(0);
			});
		});

		describe('offline mode', () => {
			it('should use pre-fetched data in offline mode when available', async () => {
				using fetcher = new PricingFetcher(true); // offline mode

				const pricing = await Result.unwrap(fetcher.fetchModelPricing());

				// Should have Claude models from pre-fetched data
				expect(pricing.size).toBeGreaterThan(0);

				// Should contain Claude models
				const claudeModels = Array.from(pricing.keys()).filter(key =>
					key.startsWith('claude-'),
				);
				expect(claudeModels.length).toBeGreaterThan(0);
			});

			it('should calculate costs in offline mode when data available', async () => {
				using fetcher = new PricingFetcher(true); // offline mode

				const cost = await Result.unwrap(fetcher.calculateCostFromTokens(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					'claude-4-sonnet-20250514',
				));

				expect(cost).toBeGreaterThan(0);
			});
		});

		describe('automatic fallback to offline mode', () => {
			/**
			 * Clean up any mocked globals after each test to prevent test interference
			 * This ensures test isolation and prevents side effects between tests
			 */
			afterEach(() => {
				vi.unstubAllGlobals();
			});

			/**
			 * Test that verifies the automatic fallback mechanism when network fetch fails.
			 * This simulates real-world scenarios where the LiteLLM API is unavailable
			 * due to network issues, service outages, or connectivity problems.
			 */
			it('should fallback to cached data when fetch fails with network error', async () => {
				// Use vitest's mock functionality to simulate network failure
				const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
				vi.stubGlobal('fetch', fetchMock);

				using fetcher = new PricingFetcher(false); // Start in online mode
				const pricing = await Result.unwrap(fetcher.fetchModelPricing());

				// Verify that fetch was called (attempting online mode first)
				expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('litellm'));

				// Verify successful fallback to cached pricing data
				expect(pricing.size).toBeGreaterThan(0);

				// Verify that Claude models are available from cached data
				const claudeModels = Array.from(pricing.keys()).filter(key =>
					key.startsWith('claude-'),
				);
				expect(claudeModels.length).toBeGreaterThan(0);
			});

			/**
			 * Test that cost calculations work correctly after automatic fallback.
			 * This ensures that the fallback mechanism doesn't break the core functionality
			 * of calculating usage costs from token counts.
			 */
			it('should calculate costs correctly after automatic fallback', async () => {
				// Simulate network failure to trigger fallback mechanism
				const fetchMock = vi.fn().mockRejectedValue(new Error('Connection timeout'));
				vi.stubGlobal('fetch', fetchMock);

				using fetcher = new PricingFetcher(false); // Start in online mode, will fallback

				const cost = await Result.unwrap(fetcher.calculateCostFromTokens(
					{
						input_tokens: 1000,
						output_tokens: 500,
					},
					'claude-4-sonnet-20250514',
				));

				// Verify that cost calculation succeeds using fallback pricing data
				expect(cost).toBeGreaterThan(0);

				// Verify that the cost is reasonable (not zero or extremely high)
				expect(cost).toBeLessThan(1); // Should be less than $1 for 1500 tokens
			});

			/**
			 * Test that verifies fallback when HTTP response indicates server error.
			 * This covers scenarios like 500 Internal Server Error, 503 Service Unavailable,
			 * or other HTTP error responses from the LiteLLM API.
			 */
			it('should fallback to cached data when HTTP response is not ok', async () => {
				// Mock HTTP error response (e.g., 503 Service Unavailable)
				const fetchMock = vi.fn().mockResolvedValue({
					ok: false,
					status: 503,
					statusText: 'Service Unavailable',
				} as Response);
				vi.stubGlobal('fetch', fetchMock);

				using fetcher = new PricingFetcher(false); // Start in online mode
				const pricing = await Result.unwrap(fetcher.fetchModelPricing());

				// Verify that fetch was attempted
				expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('litellm'));

				// Verify successful fallback despite HTTP error response
				expect(pricing.size).toBeGreaterThan(0);

				// Verify Claude models are available from cached data
				const claudeModels = Array.from(pricing.keys()).filter(key =>
					key.startsWith('claude-'),
				);
				expect(claudeModels.length).toBeGreaterThan(0);
			});
		});

		describe('getModelContextLimit', () => {
			it('should return context limit from pricing data when available', async () => {
				using fetcher = new PricingFetcher(true); // Use offline mode with cached data

				// Mock pricing data with context limits
				const mockPricing = new Map([
					['test-model', {
						input_cost_per_token: 0.00001,
						output_cost_per_token: 0.00003,
						max_input_tokens: 100_000,
					}],
				]);
				// eslint-disable-next-line ts/ban-ts-comment
				// @ts-ignore - Accessing private property for testing
				fetcher.cachedPricing = mockPricing;

				const contextLimit = await Result.unwrap(fetcher.getModelContextLimit('test-model'));
				expect(contextLimit).toBe(100_000);
			});

			it('should return null when model not found', async () => {
				using fetcher = new PricingFetcher(true);
				// eslint-disable-next-line ts/ban-ts-comment
				// @ts-ignore - Accessing private property for testing
				fetcher.cachedPricing = new Map(); // Empty cache

				const result = await Result.unwrap(fetcher.getModelContextLimit('unknown-model'));
				expect(result).toBeNull();
			});

			it('should return null when context fields are not available', async () => {
				using fetcher = new PricingFetcher(true);

				// Mock pricing data without context limits
				const mockPricing = new Map([
					['test-model', {
						input_cost_per_token: 0.00001,
						output_cost_per_token: 0.00003,
					}],
				]);
				// eslint-disable-next-line ts/ban-ts-comment
				// @ts-ignore - Accessing private property for testing
				fetcher.cachedPricing = mockPricing;

				const result = await Result.unwrap(fetcher.getModelContextLimit('test-model'));
				expect(result).toBeNull();
			});
		});
	});
}
