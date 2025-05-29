export const formatNumber = (num: number): string => {
	return num.toLocaleString("en-US");
};

export const formatCurrency = (amount: number): string => {
	return `$${amount.toFixed(2)}`;
};
