/**
 * @fileoverview Currency validation utilities
 *
 * This module provides currency validation functionality to validate
 * and normalize currency codes before conversion.
 *
 * @module currency-validator
 */

import type { CurrencyConverter } from './currency-converter.ts';
import { logger } from './logger.ts';

/**
 * Validates and normalizes a currency code
 * @param currencyCode - Currency code to validate
 * @param converter - CurrencyConverter instance for validation
 * @returns Promise<string> - Normalized currency code
 * @throws Error if currency is not supported
 */
export async function validateCurrency(
	currencyCode: string,
	converter: CurrencyConverter,
): Promise<string> {
	const normalizedCurrency = currencyCode.toUpperCase();

	// USD is always valid
	if (normalizedCurrency === 'USD') {
		return normalizedCurrency;
	}

	// Check if currency is supported
	const isSupported = await converter.isCurrencySupported(normalizedCurrency);
	if (!isSupported) {
		logger.error(`Currency '${normalizedCurrency}' is not supported. Use 'USD' or check available currencies.`);
		throw new Error(`Currency '${normalizedCurrency}' is not supported`);
	}

	return normalizedCurrency;
}

if (import.meta.vitest != null) {
	describe('currency-validator', () => {
		describe('validateCurrency', () => {
			it('should validate USD currency', async () => {
				const mockIsCurrencySupported = vi.fn().mockResolvedValue(true);
				const mockConverter = {
					isCurrencySupported: mockIsCurrencySupported,
				} as unknown as CurrencyConverter;

				const result = await validateCurrency('USD', mockConverter);
				expect(result).toBe('USD');
				expect(mockIsCurrencySupported).not.toHaveBeenCalled();
			});

			it('should validate and normalize case', async () => {
				const mockIsCurrencySupported = vi.fn().mockResolvedValue(true);
				const mockConverter = {
					isCurrencySupported: mockIsCurrencySupported,
				} as unknown as CurrencyConverter;

				const result = await validateCurrency('jpy', mockConverter);
				expect(result).toBe('JPY');
				expect(mockIsCurrencySupported).toHaveBeenCalledWith('JPY');
			});

			it('should throw error for unsupported currency', async () => {
				const mockIsCurrencySupported = vi.fn().mockResolvedValue(false);
				const mockConverter = {
					isCurrencySupported: mockIsCurrencySupported,
				} as unknown as CurrencyConverter;

				await expect(validateCurrency('FAKE', mockConverter))
					.rejects
					.toThrow('Currency \'FAKE\' is not supported');
			});

			it('should handle supported currencies', async () => {
				const mockIsCurrencySupported = vi.fn().mockResolvedValue(true);
				const mockConverter = {
					isCurrencySupported: mockIsCurrencySupported,
				} as unknown as CurrencyConverter;

				const result = await validateCurrency('EUR', mockConverter);
				expect(result).toBe('EUR');
				expect(mockIsCurrencySupported).toHaveBeenCalledWith('EUR');
			});
		});
	});
}
