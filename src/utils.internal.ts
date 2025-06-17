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
