export function formatNumber(num: number): string {
	return num.toLocaleString('en-US');
}

export function formatCurrency(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/**
 * WHY: Object.groupBy requires Node.js 21+. tsdown doesn't support runtime polyfills, only syntax transforms.
 */
export function groupBy<T, K extends PropertyKey>(
	array: readonly T[],
	keyFn: (item: T) => K,
): Record<K, T[] | undefined> {
	return array.reduce(
		(groups, item) => {
			const key = keyFn(item);
			if (groups[key] == null) {
				groups[key] = [];
			}
			groups[key]!.push(item);
			return groups;
		},
		{} as Record<K, T[] | undefined>,
	);
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
