import type { Args } from "gunshi";
import * as v from "valibot";
import { getDefaultClaudePath } from "./data-loader";
import { CostModes, dateSchema } from "./types";

const parseDateArg = (value: string): string => {
	const result = v.safeParse(dateSchema, value);
	if (!result.success) {
		throw new TypeError(result.issues[0].message);
	}
	return result.output;
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
	mode: {
		type: "string",
		short: "m",
		description:
			"Cost calculation mode: auto (use costUSD if exists, otherwise calculate), calculate (always calculate), display (always use costUSD)",
		default: "auto",
	},
	debug: {
		type: "boolean",
		short: "d",
		description: "Show pricing mismatch information for debugging",
		default: false,
	},
	debugSamples: {
		type: "number",
		description:
			"Number of sample discrepancies to show in debug output (default: 5)",
		default: 5,
	},
} as const satisfies Args;

export const sharedCommandConfig = {
	args: sharedArgs,
	toKebab: true,
} as const;
