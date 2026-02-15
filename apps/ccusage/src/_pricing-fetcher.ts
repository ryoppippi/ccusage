import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CLAUDE_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openrouter/openai/',
];

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();

/** Cache TTL in milliseconds (24 hours) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Get the cache directory path */
function getCacheDir(): string {
	return path.join(os.homedir(), '.cache', 'ccusage');
}

/** Get the pricing cache file path */
function getCacheFilePath(): string {
	return path.join(getCacheDir(), 'pricing.json');
}

/** Check if the cache file is still valid (less than 24 hours old) */
async function isCacheValid(): Promise<boolean> {
	try {
		const stats = await fs.stat(getCacheFilePath());
		const age = Date.now() - stats.mtimeMs;
		return age < CACHE_TTL_MS;
	} catch {
		return false;
	}
}

/** Load pricing from disk cache */
async function loadDiskCache(): Promise<Record<string, LiteLLMModelPricing> | null> {
	try {
		const data = await fs.readFile(getCacheFilePath(), 'utf-8');
		return JSON.parse(data) as Record<string, LiteLLMModelPricing>;
	} catch {
		return null;
	}
}

/** Save pricing to disk cache */
async function saveDiskCache(pricing: Map<string, LiteLLMModelPricing>): Promise<void> {
	try {
		const cacheDir = getCacheDir();
		await fs.mkdir(cacheDir, { recursive: true });
		const obj = Object.fromEntries(pricing);
		await fs.writeFile(getCacheFilePath(), JSON.stringify(obj));
	} catch (error) {
		logger.debug('Failed to save pricing cache:', error);
	}
}

export type PricingFetcherOptions = {
	/** Use bundled offline pricing (ignores cache and network) */
	offline?: boolean;
	/** Force refresh from network (ignores cache) */
	refreshPricing?: boolean;
};

export class PricingFetcher extends LiteLLMPricingFetcher {
	private readonly refreshPricing: boolean;
	private diskCacheLoaded = false;

	constructor(options: PricingFetcherOptions | boolean = {}) {
		// support legacy boolean signature
		const opts = typeof options === 'boolean' ? { offline: options } : options;

		super({
			offline: opts.offline ?? false,
			offlineLoader: async () => PREFETCHED_CLAUDE_PRICING,
			logger,
			providerPrefixes: CLAUDE_PROVIDER_PREFIXES,
		});

		this.refreshPricing = opts.refreshPricing ?? false;
	}

	override async fetchModelPricing(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		// if refresh requested, skip cache
		if (this.refreshPricing) {
			logger.debug('Refresh pricing flag set, fetching fresh data');
			return this.fetchAndCache();
		}

		// try disk cache first (unless offline mode which uses bundled data)
		if (!this.diskCacheLoaded) {
			this.diskCacheLoaded = true;
			const cacheValid = await isCacheValid();
			if (cacheValid) {
				const cached = await loadDiskCache();
				if (cached != null) {
					const pricing = new Map(Object.entries(cached));
					logger.debug(`Using cached pricing for ${pricing.size} models`);
					// set internal cache so subsequent calls use it
					this.setCachedPricing(pricing);
					return Result.succeed(pricing);
				}
			}
		}

		// fall back to parent implementation (network fetch or offline)
		return this.fetchAndCache();
	}

	private async fetchAndCache(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		const result = await super.fetchModelPricing();
		if (Result.isSuccess(result)) {
			// save to disk cache for next run
			await saveDiskCache(result.value);
		}
		return result;
	}

	private setCachedPricing(pricing: Map<string, LiteLLMModelPricing>): void {
		// access parent's private cache via type assertion
		(this as unknown as { cachedPricing: Map<string, LiteLLMModelPricing> | null }).cachedPricing =
			pricing;
	}
}

if (import.meta.vitest != null) {
	describe('PricingFetcher', () => {
		it('loads offline pricing when offline flag is true', async () => {
			using fetcher = new PricingFetcher({ offline: true });
			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBeGreaterThan(0);
		});

		it('supports legacy boolean signature', async () => {
			using fetcher = new PricingFetcher(true);
			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBeGreaterThan(0);
		});

		it('calculates cost for Claude model tokens', async () => {
			using fetcher = new PricingFetcher({ offline: true });
			const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-20250514'));
			const cost = fetcher.calculateCostFromPricing(
				{
					input_tokens: 1000,
					output_tokens: 500,
					cache_read_input_tokens: 300,
				},
				pricing!,
			);

			expect(cost).toBeGreaterThan(0);
		});
	});
}
