/**
 * @fileoverview Currency exchange rate fetcher with daily caching
 *
 * This module provides an ExchangeRateFetcher class that retrieves and caches
 * currency exchange rates from exchangerate-api.com with daily cache limits
 * to respect the free tier API limitations (1 request per day).
 *
 * @module exchange-rate-fetcher
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.ts';

/**
 * Exchange rate data structure
 */
export type ExchangeRateData = {
	/** Base currency (always USD) */
	base_code: string;
	/** Exchange rates mapping */
	rates: Record<string, number>;
	/** Last update timestamp */
	time_last_update_unix: number;
	/** Cache timestamp when data was fetched */
	cached_at: number;
};

/**
 * Cache file structure for exchange rates
 */
type ExchangeRateCache = {
	data: ExchangeRateData;
	fetched_date: string; // YYYY-MM-DD format
};

/**
 * Exchange rate API response structure
 */
type ExchangeRateApiResponse = {
	result: string;
	base_code: string;
	rates: Record<string, number>;
	time_last_update_unix: number;
};

/**
 * Fetches and caches currency exchange rates with daily limits
 * Implements daily caching to respect API rate limits (1 request per day for free tier)
 */
export class ExchangeRateFetcher implements Disposable {
	private static readonly API_URL = 'https://open.er-api.com/v6/latest/USD';
	private static readonly CACHE_DIR = join(homedir(), '.claude', 'ccusage-cache');
	private static readonly CACHE_FILE = join(ExchangeRateFetcher.CACHE_DIR, 'exchange-rates.json');

	private cachedRates: ExchangeRateData | null = null;

	/**
	 * Creates a new ExchangeRateFetcher instance
	 */
	constructor() {
		// Ensure cache directory exists
		if (!existsSync(ExchangeRateFetcher.CACHE_DIR)) {
			mkdirSync(ExchangeRateFetcher.CACHE_DIR, { recursive: true });
		}
	}

	/**
	 * Implements Disposable interface for automatic cleanup
	 */
	[Symbol.dispose](): void {
		this.clearCache();
	}

	/**
	 * Clears the cached exchange rate data
	 */
	clearCache(): void {
		this.cachedRates = null;
	}

	/**
	 * Gets current date in YYYY-MM-DD format
	 * @returns Current date string
	 */
	private getCurrentDateString(): string {
		return new Date().toISOString().split('T')[0]!;
	}

	/**
	 * Loads exchange rates from local cache file
	 * @returns Cached exchange rate data or null if not valid
	 */
	private loadFromCache(): ExchangeRateData | null {
		try {
			if (!existsSync(ExchangeRateFetcher.CACHE_FILE)) {
				logger.debug('Exchange rate cache file does not exist');
				return null;
			}

			const cacheContent = readFileSync(ExchangeRateFetcher.CACHE_FILE, 'utf-8');
			const cache = JSON.parse(cacheContent) as ExchangeRateCache;

			// Check if cache is from today
			const today = this.getCurrentDateString();
			if (cache.fetched_date !== today) {
				logger.debug(`Exchange rate cache is from ${cache.fetched_date}, today is ${today}. Cache expired.`);
				return null;
			}

			logger.debug('Using cached exchange rates from today');
			return cache.data;
		}
		catch (error) {
			logger.warn('Failed to load exchange rate cache:', error);
			return null;
		}
	}

	/**
	 * Saves exchange rate data to local cache file
	 * @param data - Exchange rate data to cache
	 */
	private saveToCache(data: ExchangeRateData): void {
		try {
			const cache: ExchangeRateCache = {
				data,
				fetched_date: this.getCurrentDateString(),
			};

			writeFileSync(ExchangeRateFetcher.CACHE_FILE, JSON.stringify(cache, null, 2));
			logger.debug('Exchange rates cached successfully');
		}
		catch (error) {
			logger.warn('Failed to save exchange rate cache:', error);
		}
	}

	/**
	 * Fetches exchange rates from the API
	 * @returns Exchange rate data from API
	 */
	private async fetchFromApi(): Promise<ExchangeRateData> {
		logger.info('Fetching latest exchange rates from API (1 daily request limit)...');

		const response = await fetch(ExchangeRateFetcher.API_URL);
		if (!response.ok) {
			throw new Error(`Failed to fetch exchange rates: ${response.status} ${response.statusText}`);
		}

		const apiData = await response.json() as ExchangeRateApiResponse;

		if (apiData.result !== 'success') {
			throw new Error('Exchange rate API returned unsuccessful result');
		}

		const data: ExchangeRateData = {
			base_code: apiData.base_code,
			rates: apiData.rates,
			time_last_update_unix: apiData.time_last_update_unix,
			cached_at: Date.now(),
		};

		// Save to cache for future use
		this.saveToCache(data);

		logger.info(`Fetched exchange rates for ${Object.keys(data.rates).length} currencies`);
		return data;
	}

	/**
	 * Gets exchange rate data, using cache if available and valid, otherwise fetching from API
	 * @returns Exchange rate data
	 */
	private async ensureExchangeRatesLoaded(): Promise<ExchangeRateData> {
		// Return cached data if already loaded
		if (this.cachedRates != null) {
			return this.cachedRates;
		}

		// Try to load from cache first
		const cachedData = this.loadFromCache();
		if (cachedData != null) {
			this.cachedRates = cachedData;
			return cachedData;
		}

		// Cache miss or expired, fetch from API
		try {
			const freshData = await this.fetchFromApi();
			this.cachedRates = freshData;
			return freshData;
		}
		catch (error) {
			logger.error('Failed to fetch exchange rates from API:', error);
			throw new Error('Unable to fetch current exchange rates. Please check your internet connection or try again later.');
		}
	}

	/**
	 * Gets the exchange rate for a specific currency relative to USD
	 * @param currencyCode - Three-letter currency code (e.g., 'JPY', 'EUR')
	 * @returns Exchange rate or null if currency not found
	 */
	async getExchangeRate(currencyCode: string): Promise<number | null> {
		const upperCode = currencyCode.toUpperCase();

		// USD to USD is always 1
		if (upperCode === 'USD') {
			return 1;
		}

		const rates = await this.ensureExchangeRatesLoaded();
		const rate = rates.rates[upperCode];

		if (rate == null) {
			logger.warn(`Exchange rate not found for currency: ${upperCode}`);
			return null;
		}

		return rate;
	}

	/**
	 * Converts USD amount to target currency
	 * @param usdAmount - Amount in USD
	 * @param targetCurrency - Target currency code
	 * @returns Converted amount or null if currency not supported
	 */
	async convertFromUsd(usdAmount: number, targetCurrency: string): Promise<number | null> {
		const rate = await this.getExchangeRate(targetCurrency);
		if (rate == null) {
			return null;
		}

		return usdAmount * rate;
	}

	/**
	 * Gets all available currency codes
	 * @returns Array of supported currency codes
	 */
	async getSupportedCurrencies(): Promise<string[]> {
		const rates = await this.ensureExchangeRatesLoaded();
		return Object.keys(rates.rates).sort();
	}

	/**
	 * Gets cache information for debugging
	 * @returns Cache status information
	 */
	async getCacheInfo(): Promise<{
		hasCachedData: boolean;
		cacheDate?: string;
		lastUpdate?: Date;
		currencyCount?: number;
	}> {
		try {
			if (existsSync(ExchangeRateFetcher.CACHE_FILE)) {
				const cacheContent = readFileSync(ExchangeRateFetcher.CACHE_FILE, 'utf-8');
				const cache = JSON.parse(cacheContent) as ExchangeRateCache;

				return {
					hasCachedData: true,
					cacheDate: cache.fetched_date,
					lastUpdate: new Date(cache.data.time_last_update_unix * 1000),
					currencyCount: Object.keys(cache.data.rates).length,
				};
			}
		}
		catch (error) {
			logger.debug('Error reading cache info:', error);
		}

		return { hasCachedData: false };
	}
}

if (import.meta.vitest != null) {
	describe('exchange-rate-fetcher', () => {
		describe('ExchangeRateFetcher', () => {
			it('should support using statement for automatic cleanup', async () => {
				let fetcherDisposed = false;

				class TestExchangeRateFetcher extends ExchangeRateFetcher {
					override [Symbol.dispose](): void {
						super[Symbol.dispose]();
						fetcherDisposed = true;
					}
				}

				{
					using fetcher = new TestExchangeRateFetcher();
					const rate = await fetcher.getExchangeRate('JPY');
					expect(rate).toBeGreaterThan(0);
				}

				expect(fetcherDisposed).toBe(true);
			});

			it('should return 1 for USD to USD conversion', async () => {
				using fetcher = new ExchangeRateFetcher();
				const rate = await fetcher.getExchangeRate('USD');
				expect(rate).toBe(1);
			});

			it('should fetch and return exchange rates', async () => {
				using fetcher = new ExchangeRateFetcher();

				const jpyRate = await fetcher.getExchangeRate('JPY');
				expect(jpyRate).toBeGreaterThan(0);
				expect(jpyRate).toBeGreaterThan(100); // JPY should be > 100 per USD

				const eurRate = await fetcher.getExchangeRate('EUR');
				expect(eurRate).toBeGreaterThan(0);
				expect(eurRate).toBeLessThan(2); // EUR should be < 2 per USD
			});

			it('should convert USD amounts correctly', async () => {
				using fetcher = new ExchangeRateFetcher();

				const jpyAmount = await fetcher.convertFromUsd(1, 'JPY');
				expect(jpyAmount).toBeGreaterThan(100);

				const eurAmount = await fetcher.convertFromUsd(1, 'EUR');
				expect(eurAmount).toBeGreaterThan(0);
				expect(eurAmount).toBeLessThan(2);
			});

			it('should return null for unsupported currencies', async () => {
				using fetcher = new ExchangeRateFetcher();

				const rate = await fetcher.getExchangeRate('FAKE');
				expect(rate).toBeNull();

				const amount = await fetcher.convertFromUsd(100, 'FAKE');
				expect(amount).toBeNull();
			});

			it('should return list of supported currencies', async () => {
				using fetcher = new ExchangeRateFetcher();

				const currencies = await fetcher.getSupportedCurrencies();
				expect(currencies).toContain('JPY');
				expect(currencies).toContain('EUR');
				expect(currencies).toContain('USD');
				expect(currencies.length).toBeGreaterThan(100);
			});

			it('should provide cache information', async () => {
				using fetcher = new ExchangeRateFetcher();

				// Force a fetch to ensure cache exists
				await fetcher.getExchangeRate('JPY');

				const cacheInfo = await fetcher.getCacheInfo();
				expect(cacheInfo.hasCachedData).toBe(true);
				expect(cacheInfo.cacheDate).toBeDefined();
				expect(cacheInfo.lastUpdate).toBeInstanceOf(Date);
				expect(cacheInfo.currencyCount).toBeGreaterThan(100);
			});
		});
	});
}
