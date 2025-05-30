import type { Currency } from "./config";

const CONVERSION_RATES: Record<Currency, number> = {
	USD: 1,
	JPY: 150,
};

const CURRENCY_SYMBOLS: Record<Currency, string> = {
	USD: "$",
	JPY: "¥",
};

const CURRENCY_DECIMALS: Record<Currency, number> = {
	USD: 2,
	JPY: 0,
};

export function convertFromUSD(
	amountUSD: number,
	toCurrency: Currency,
): number {
	const rate = CONVERSION_RATES[toCurrency];
	return amountUSD * rate;
}

export function formatCurrencyAmount(
	amount: number,
	currency: Currency,
): string {
	const symbol = CURRENCY_SYMBOLS[currency];
	const decimals = CURRENCY_DECIMALS[currency];

	// Format with proper locale (includes comma separators)
	const formattedAmount = amount.toLocaleString("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});

	return `${symbol}${formattedAmount}`;
}

export function getCurrencyLabel(currency: Currency): string {
	return `Cost (${currency})`;
}
