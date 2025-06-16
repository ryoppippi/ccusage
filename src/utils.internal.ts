import pc from 'picocolors';

export function formatNumber(num: number): string {
	return num.toLocaleString('en-US');
}

export function formatCurrency(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

export function formatDuration(milliseconds: number): string {
	const totalMinutes = Math.floor(milliseconds / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours === 0) {
		return `${minutes}m`;
	}
	return `${hours}h ${minutes}m`;
}

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

export function formatModelsDisplay(models: string[]): string {
	// Format array of models for display
	const uniqueModels = [...new Set(models.map(formatModelName))];
	return uniqueModels.sort().join(', ');
}

// Window calculation utilities
/**
 * Calculate the 5-hour window ID for a given timestamp
 * Windows start at: 00:00, 05:00, 10:00, 15:00, 20:00 UTC
 */
export function get5HourWindowId(timestamp: string): string {
	const dt = new Date(timestamp);
	const utcHour = dt.getUTCHours();
	const windowStartHour = Math.floor(utcHour / 5) * 5;
	const windowDate = dt.toISOString().split('T')[0];
	return `${windowDate}-${windowStartHour.toString().padStart(2, '0')}`;
}

/**
 * Get window start time for display
 */
export function getWindowStartTime(windowId: string): Date {
	// windowId format: YYYY-MM-DD-HH
	const parts = windowId.split('-');
	const year = parts[0];
	const month = parts[1];
	const day = parts[2];
	const hour = parts[3];
	return new Date(`${year}-${month}-${day}T${hour}:00:00Z`);
}

// Complex display utilities
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
