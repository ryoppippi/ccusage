import type { Currency } from "./config";
import { convertFromUSD, formatCurrencyAmount } from "./currency";

export const formatNumber = (num: number): string => {
	return num.toLocaleString("en-US");
};

export const formatCurrency = (
	amountUSD: number,
	currency: Currency,
): string => {
	const convertedAmount = convertFromUSD(amountUSD, currency);
	return formatCurrencyAmount(convertedAmount, currency);
};
