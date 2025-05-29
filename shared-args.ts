import type { Args } from "gunshi";
import * as v from "valibot";
import { dateSchema } from "./types";

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
		description: "Custom path to Claude data directory (default: ~/.claude)",
	},
	json: {
		type: "boolean",
		short: "j",
		description: "Output in JSON format",
	},
} as const satisfies Args;
