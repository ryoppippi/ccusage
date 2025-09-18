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
			Result.map((pricing) => {
				if (pricing == null) {
					return null;
				}
				return pricing.max_input_tokens ?? null;
			}),
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

		if (pricing.input_cost_per_token != null) {
			cost += tokens.input_tokens * pricing.input_cost_per_token;
		}

		if (pricing.output_cost_per_token != null) {
			cost += tokens.output_tokens * pricing.output_cost_per_token;
		}

		if (
			tokens.cache_creation_input_tokens != null
			&& pricing.cache_creation_input_token_cost != null
		) {
			cost
				+= tokens.cache_creation_input_tokens
					* pricing.cache_creation_input_token_cost;
		}

		if (tokens.cache_read_input_tokens != null && pricing.cache_read_input_token_cost != null) {
			cost
				+= tokens.cache_read_input_tokens * pricing.cache_read_input_token_cost;
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
	});
}
