/**
 * @fileoverview Currency conversion utilities for ccusage
 *
 * This module provides currency conversion functionality, combining
 * exchange rate fetching with currency formatting to convert and display
 * USD amounts in different currencies.
 *
 * @module currency-converter
 */

import { formatCurrency } from './_utils.ts';
import { ExchangeRateFetcher } from './exchange-rate-fetcher.ts';
import { logger } from './logger.ts';

/**
 * Currency converter class that combines exchange rate fetching with formatting
 * Implements Disposable pattern for automatic resource cleanup
 */
export class CurrencyConverter implements Disposable {
	private exchangeRateFetcher: ExchangeRateFetcher;

	/**
	 * Creates a new CurrencyConverter instance
	 */
	constructor() {
		this.exchangeRateFetcher = new ExchangeRateFetcher();
	}

	/**
	 * Implements Disposable interface for automatic cleanup
	 */
	[Symbol.dispose](): void {
		this.exchangeRateFetcher[Symbol.dispose]();
	}

	/**
	 * Converts USD amount to target currency and formats it
	 * @param usdAmount - Amount in USD to convert
	 * @param targetCurrency - Target currency code (e.g., 'JPY', 'EUR')
	 * @returns Formatted currency string or null if conversion fails
	 */
	async convertAndFormat(usdAmount: number, targetCurrency: string): Promise<string | null> {
		const upperCurrency = targetCurrency.toUpperCase();

		// No conversion needed for USD
		if (upperCurrency === 'USD') {
			return formatCurrency(usdAmount, 'USD');
		}

		try {
			const convertedAmount = await this.exchangeRateFetcher.convertFromUsd(usdAmount, upperCurrency);

			if (convertedAmount == null) {
				logger.warn(`Currency conversion failed: ${upperCurrency} not supported`);
				return null;
			}

			return formatCurrency(convertedAmount, upperCurrency);
		}
		catch (error) {
			logger.error(`Failed to convert currency to ${upperCurrency}:`, error);
			return null;
		}
	}

	/**
	 * Converts USD amount to target currency without formatting
	 * @param usdAmount - Amount in USD to convert
	 * @param targetCurrency - Target currency code
	 * @returns Converted amount or null if conversion fails
	 */
	async convertAmount(usdAmount: number, targetCurrency: string): Promise<number | null> {
		const upperCurrency = targetCurrency.toUpperCase();

		// No conversion needed for USD
		if (upperCurrency === 'USD') {
			return usdAmount;
		}

		try {
			return await this.exchangeRateFetcher.convertFromUsd(usdAmount, upperCurrency);
		}
		catch (error) {
			logger.error(`Failed to convert currency to ${upperCurrency}:`, error);
			return null;
		}
	}

	/**
	 * Gets the list of supported currencies
	 * @returns Array of supported currency codes
	 */
	async getSupportedCurrencies(): Promise<string[]> {
		try {
			return await this.exchangeRateFetcher.getSupportedCurrencies();
		}
		catch (error) {
			logger.error('Failed to get supported currencies:', error);
			return ['USD']; // Fallback to USD only
		}
	}

	/**
	 * Validates if a currency is supported
	 * @param currencyCode - Currency code to validate
	 * @returns True if currency is supported
	 */
	async isCurrencySupported(currencyCode: string): Promise<boolean> {
		const upperCode = currencyCode.toUpperCase();

		// USD is always supported
		if (upperCode === 'USD') {
			return true;
		}

		try {
			const rate = await this.exchangeRateFetcher.getExchangeRate(upperCode);
			return rate != null;
		}
		catch (error) {
			logger.debug(`Currency validation failed for ${upperCode}:`, error);
			return false;
		}
	}

	/**
	 * Gets cache information for debugging
	 * @returns Exchange rate cache information
	 */
	async getCacheInfo(): Promise<{
		hasCachedData: boolean;
		cacheDate?: string;
		lastUpdate?: Date;
		currencyCount?: number;
	}> {
		return this.exchangeRateFetcher.getCacheInfo();
	}

	/**
	 * Gets the appropriate currency column header
	 * @param currencyCode - Currency code for the header
	 * @returns Formatted column header string
	 */
	getCurrencyColumnHeader(currencyCode: string): string {
		const upperCode = currencyCode.toUpperCase();
		return upperCode === 'USD' ? 'Cost (USD)' : `Cost (${upperCode})`;
	}
}

/**
 * Convenience function to create and use a currency converter with automatic disposal
 * @param currencyCode - Target currency code
 * @param callback - Function to execute with the converter
 * @returns Result of the callback function
 */
export async function withCurrencyConverter<T>(
	currencyCode: string,
	callback: (converter: CurrencyConverter) => Promise<T>,
): Promise<T> {
	using converter = new CurrencyConverter();
	return await callback(converter);
}

if (import.meta.vitest != null) {
	describe('currency-converter', () => {
		describe('CurrencyConverter', () => {
			it('should support using statement for automatic cleanup', async () => {
				let converterDisposed = false;

				class TestCurrencyConverter extends CurrencyConverter {
					override [Symbol.dispose](): void {
						super[Symbol.dispose]();
						converterDisposed = true;
					}
				}

				{
					using converter = new TestCurrencyConverter();
					const result = await converter.convertAndFormat(1, 'USD');
					expect(result).toBe('$1.00');
				}

				expect(converterDisposed).toBe(true);
			});

			it('should convert and format USD amounts correctly', async () => {
				using converter = new CurrencyConverter();

				const usdResult = await converter.convertAndFormat(10.50, 'USD');
				expect(usdResult).toBe('$10.50');
			});

			it('should convert to other currencies', async () => {
				using converter = new CurrencyConverter();

				const jpyResult = await converter.convertAndFormat(1, 'JPY');
				expect(jpyResult).toMatch(/^¥\d+$/); // Should be formatted JPY without decimals

				const eurResult = await converter.convertAndFormat(1, 'EUR');
				expect(eurResult).toMatch(/^\d+\.\d{2}€$/); // Should be formatted EUR with decimals
			});

			it('should handle case insensitive currency codes', async () => {
				using converter = new CurrencyConverter();

				const result = await converter.convertAndFormat(1, 'usd');
				expect(result).toBe('$1.00');
			});

			it('should return null for unsupported currencies', async () => {
				using converter = new CurrencyConverter();

				const result = await converter.convertAndFormat(1, 'FAKE');
				expect(result).toBeNull();
			});

			it('should convert amounts without formatting', async () => {
				using converter = new CurrencyConverter();

				const usdAmount = await converter.convertAmount(10, 'USD');
				expect(usdAmount).toBe(10);

				const jpyAmount = await converter.convertAmount(1, 'JPY');
				expect(jpyAmount).toBeGreaterThan(100); // JPY should be > 100 per USD
			});

			it('should validate currency support', async () => {
				using converter = new CurrencyConverter();

				const usdSupported = await converter.isCurrencySupported('USD');
				expect(usdSupported).toBe(true);

				const jpySupported = await converter.isCurrencySupported('JPY');
				expect(jpySupported).toBe(true);

				const fakeSupported = await converter.isCurrencySupported('FAKE');
				expect(fakeSupported).toBe(false);
			});

			it('should get supported currencies list', async () => {
				using converter = new CurrencyConverter();

				const currencies = await converter.getSupportedCurrencies();
				expect(currencies).toContain('USD');
				expect(currencies).toContain('JPY');
				expect(currencies).toContain('EUR');
				expect(currencies.length).toBeGreaterThan(100);
			});

			it('should provide currency column headers', () => {
				using converter = new CurrencyConverter();

				expect(converter.getCurrencyColumnHeader('USD')).toBe('Cost (USD)');
				expect(converter.getCurrencyColumnHeader('JPY')).toBe('Cost (JPY)');
				expect(converter.getCurrencyColumnHeader('eur')).toBe('Cost (EUR)');
			});

			it('should provide cache information', async () => {
				using converter = new CurrencyConverter();

				// Force a fetch to ensure cache exists
				await converter.convertAndFormat(1, 'JPY');

				const cacheInfo = await converter.getCacheInfo();
				expect(cacheInfo.hasCachedData).toBe(true);
				expect(cacheInfo.cacheDate).toBeDefined();
				expect(cacheInfo.lastUpdate).toBeInstanceOf(Date);
				expect(cacheInfo.currencyCount).toBeGreaterThan(100);
			});
		});

		describe('withCurrencyConverter', () => {
			it('should automatically dispose converter after use', async () => {
				let disposed = false;

				// Mock the converter disposal to track it
				const originalDispose = CurrencyConverter.prototype[Symbol.dispose];
				CurrencyConverter.prototype[Symbol.dispose] = function () {
					disposed = true;
					originalDispose.call(this);
				};

				const result = await withCurrencyConverter('USD', async (converter) => {
					const formatted = await converter.convertAndFormat(1, 'USD');
					return formatted;
				});

				expect(result).toBe('$1.00');
				expect(disposed).toBe(true);

				// Restore original dispose method
				CurrencyConverter.prototype[Symbol.dispose] = originalDispose;
			});
		});
	});
}
