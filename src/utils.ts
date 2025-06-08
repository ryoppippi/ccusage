export function formatNumber(num: number): string {
	return num.toLocaleString('en-US');
}

export function formatCurrency(amount: number): string {
	return `$${amount.toFixed(2)}`;
}
