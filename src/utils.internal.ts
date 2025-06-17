import pc from 'picocolors';

/**
 * Formats a number with locale-specific thousand separators
 * @param num - The number to format
 * @returns Formatted number string with commas as thousand separators
 */
export function formatNumber(num: number): string {
	return num.toLocaleString('en-US');
}

/**
 * Formats a number as USD currency with dollar sign and 2 decimal places
 * @param amount - The amount to format
 * @returns Formatted currency string (e.g., "$12.34")
 */
export function formatCurrency(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/**
 * Formats Claude model names into a shorter, more readable format
 * Extracts model type and generation from full model name
 * @param modelName - Full model name (e.g., "claude-sonnet-4-20250514")
 * @returns Shortened model name (e.g., "sonnet-4") or original if pattern doesn't match
 */
export function formatModelName(modelName: string): string {
	// Extract model type from full model name
	// e.g., "claude-sonnet-4-20250514" -> "sonnet-4"
	// e.g., "claude-opus-4-20250514" -> "opus-4"
	const match = modelName.match(/claude-(\w+)-(\d+)-\d+/);
	if (match != null) {
		return `${match[1]}-${match[2]}`;
	}
	// Return original if pattern doesn't match
	return modelName;
}

/**
 * Formats an array of model names for display as a comma-separated string
 * Removes duplicates and sorts alphabetically
 * @param models - Array of model names
 * @returns Formatted string with unique, sorted model names separated by commas
 */
export function formatModelsDisplay(models: string[]): string {
	// Format array of models for display
	const uniqueModels = [...new Set(models.map(formatModelName))];
	return uniqueModels.sort().join(', ');
}

/**
 * Pushes model breakdown rows to a table
 * @param table - The table to push rows to
 * @param table.push - Method to add rows to the table
 * @param breakdowns - Array of model breakdowns
 * @param extraColumns - Number of extra empty columns before the data (default: 1 for models column)
 * @param trailingColumns - Number of extra empty columns after the data (default: 0)
 */
export function pushBreakdownRows(
	table: { push: (row: (string | number)[]) => void },
	breakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>,
	extraColumns = 1,
	trailingColumns = 0,
): void {
	for (const breakdown of breakdowns) {
		const row: (string | number)[] = [`  └─ ${formatModelName(breakdown.modelName)}`];

		// Add extra empty columns before data
		for (let i = 0; i < extraColumns; i++) {
			row.push('');
		}

		// Add data columns with gray styling
		const totalTokens = breakdown.inputTokens + breakdown.outputTokens
			+ breakdown.cacheCreationTokens + breakdown.cacheReadTokens;

		row.push(
			pc.gray(formatNumber(breakdown.inputTokens)),
			pc.gray(formatNumber(breakdown.outputTokens)),
			pc.gray(formatNumber(breakdown.cacheCreationTokens)),
			pc.gray(formatNumber(breakdown.cacheReadTokens)),
			pc.gray(formatNumber(totalTokens)),
			pc.gray(formatCurrency(breakdown.cost)),
		);

		// Add trailing empty columns
		for (let i = 0; i < trailingColumns; i++) {
			row.push('');
		}

		table.push(row);
	}
}

if (import.meta.vitest != null) {
	describe('formatNumber', () => {
		it('formats positive numbers with comma separators', () => {
			expect(formatNumber(1000)).toBe('1,000');
			expect(formatNumber(1000000)).toBe('1,000,000');
			expect(formatNumber(1234567.89)).toBe('1,234,567.89');
		});

		it('formats small numbers without separators', () => {
			expect(formatNumber(0)).toBe('0');
			expect(formatNumber(1)).toBe('1');
			expect(formatNumber(999)).toBe('999');
		});

		it('formats negative numbers', () => {
			expect(formatNumber(-1000)).toBe('-1,000');
			expect(formatNumber(-1234567.89)).toBe('-1,234,567.89');
		});

		it('formats decimal numbers', () => {
			expect(formatNumber(1234.56)).toBe('1,234.56');
			expect(formatNumber(0.123)).toBe('0.123');
		});

		it('handles edge cases', () => {
			expect(formatNumber(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
			expect(formatNumber(Number.MIN_SAFE_INTEGER)).toBe(
				'-9,007,199,254,740,991',
			);
		});
	});

	describe('formatCurrency', () => {
		it('formats positive amounts', () => {
			expect(formatCurrency(10)).toBe('$10.00');
			expect(formatCurrency(100.5)).toBe('$100.50');
			expect(formatCurrency(1234.56)).toBe('$1234.56');
		});

		it('formats zero', () => {
			expect(formatCurrency(0)).toBe('$0.00');
		});

		it('formats negative amounts', () => {
			expect(formatCurrency(-10)).toBe('$-10.00');
			expect(formatCurrency(-100.5)).toBe('$-100.50');
		});

		it('rounds to two decimal places', () => {
			expect(formatCurrency(10.999)).toBe('$11.00');
			expect(formatCurrency(10.994)).toBe('$10.99');
			expect(formatCurrency(10.995)).toBe('$10.99'); // JavaScript's toFixed uses banker's rounding
		});

		it('handles small decimal values', () => {
			expect(formatCurrency(0.01)).toBe('$0.01');
			expect(formatCurrency(0.001)).toBe('$0.00');
			expect(formatCurrency(0.009)).toBe('$0.01');
		});

		it('handles large numbers', () => {
			expect(formatCurrency(1000000)).toBe('$1000000.00');
			expect(formatCurrency(9999999.99)).toBe('$9999999.99');
		});
	});
}
