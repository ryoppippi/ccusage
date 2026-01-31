import type { Args } from 'gunshi';
import * as v from 'valibot';

/**
 * Filter date schema for YYYYMMDD format (e.g., 20250125)
 */
const filterDateRegex = /^\d{8}$/;
export const filterDateSchema = v.pipe(
	v.string(),
	v.regex(filterDateRegex, 'Date must be in YYYYMMDD format (e.g., 20250125)'),
	v.brand('FilterDate'),
);

/**
 * Parses and validates a date argument in YYYYMMDD format
 * @param value - Date string to parse
 * @returns Validated date string
 */
function parseDateArg(value: string): string {
	return v.parse(filterDateSchema, value);
}

/**
 * Shared command line arguments used across multiple opencode CLI commands
 */
export const sharedArgs = {
	since: {
		type: 'custom',
		short: 's',
		description: 'Filter from date (YYYYMMDD format, e.g., 20250125)',
		parse: parseDateArg,
	},
	until: {
		type: 'custom',
		short: 'u',
		description: 'Filter until date (YYYYMMDD format, e.g., 20250130)',
		parse: parseDateArg,
	},
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output in JSON format',
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table mode',
	},
} as const satisfies Args;
