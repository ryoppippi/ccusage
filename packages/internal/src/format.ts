/**
 * Format a number as tokens with locale-specific formatting
 * @param value - Token count to format
 * @returns Formatted token string
 */
export function formatTokens(value: number): string {
	return new Intl.NumberFormat('en-US').format(Math.round(value));
}

/**
 * Format a number as USD currency
 * @param value - Amount in USD
 * @param locale - Locale for formatting (default: 'en-US')
 * @returns Formatted currency string
 */
export function formatCurrency(value: number, locale?: string): string {
	return new Intl.NumberFormat(locale ?? 'en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 4,
		maximumFractionDigits: 4,
	}).format(value);
}
