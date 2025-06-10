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
