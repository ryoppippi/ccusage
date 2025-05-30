import type { Args } from "gunshi";
import * as v from "valibot";
import { type Currency, getCurrency, setCurrency } from "./config";
import { getDefaultClaudePath } from "./data-loader";
import { dateSchema } from "./types";

const parseDateArg = (value: string): string => {
	const result = v.safeParse(dateSchema, value);
	if (!result.success) {
		throw new TypeError(result.issues[0].message);
	}
	return result.output;
};

const parseCurrencyArg = (value: string): Currency => {
	const upperValue = value.toUpperCase() as Currency;
	if (upperValue !== "USD" && upperValue !== "JPY") {
		throw new TypeError(`Invalid currency: ${value}. Must be USD or JPY.`);
	}
	setCurrency(upperValue);
	return upperValue;
};

export const sharedArgs = {
	since: {
		type: "custom",
		short: "s",
		description: "Filter from date (YYYYMMDD format)",
		parse: parseDateArg,
	},
	until: {
		type: "custom",
		short: "u",
		description: "Filter until date (YYYYMMDD format)",
		parse: parseDateArg,
	},
	path: {
		type: "string",
		short: "p",
		description: "Custom path to Claude data directory",
		default: getDefaultClaudePath(),
	},
	json: {
		type: "boolean",
		short: "j",
		description: "Output in JSON format",
		default: false,
	},
	currency: {
		type: "custom",
		short: "c",
		description: "Display currency (USD or JPY)",
		parse: parseCurrencyArg,
		default: getCurrency(),
	},
} as const satisfies Args;
