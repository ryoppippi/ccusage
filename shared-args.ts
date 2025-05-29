import type { Args } from "gunshi";
import { parseDateArg } from "./date-validation.ts";

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
