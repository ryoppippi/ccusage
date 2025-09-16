import type { Args } from 'gunshi';
import type { CostMode, SortOrder } from './_types.ts';
import { DEFAULT_LOCALE } from './_consts.ts';
import { CostModes, filterDateSchema, SortOrders } from './_types.ts';

/**
 * Parses and validates a date argument in YYYYMMDD format
 * @param value - Date string to parse
 * @returns Validated date string
 * @throws TypeError if date format is invalid
 */
function parseDateArg(value: string): string {
	const result = filterDateSchema.safeParse(value);
	if (!result.success) {
		throw new TypeError(result.error.issues[0]?.message ?? 'Invalid date format');
	}
	return result.data;
}

/**
 * Shared command line arguments used across multiple CLI commands
 */
export const sharedArgs = {
	since: {
		type: 'custom',
		short: 's',
		description: 'Filter from date (YYYYMMDD format)',
		parse: parseDateArg,
	},
	until: {
		type: 'custom',
		short: 'u',
		description: 'Filter until date (YYYYMMDD format)',
		parse: parseDateArg,
	},
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output in JSON format',
		default: false,
	},
	mode: {
		type: 'enum',
		short: 'm',
		description:
			'Cost calculation mode: auto (use costUSD if exists, otherwise calculate), calculate (always calculate), display (always use costUSD)',
		default: 'auto' as const satisfies CostMode,
		choices: CostModes,
	},
	debug: {
		type: 'boolean',
		short: 'd',
		description: 'Show pricing mismatch information for debugging',
		default: false,
	},
	debugSamples: {
		type: 'number',
		description:
			'Number of sample discrepancies to show in debug output (default: 5)',
		default: 5,
	},
	order: {
		type: 'enum',
		short: 'o',
		description: 'Sort order: desc (newest first) or asc (oldest first)',
		default: 'asc' as const satisfies SortOrder,
		choices: SortOrders,
	},
	breakdown: {
		type: 'boolean',
		short: 'b',
		description: 'Show per-model cost breakdown',
		default: false,
	},
	offline: {
		type: 'boolean',
		negatable: true,
		short: 'O',
		description: 'Use cached pricing data for Claude models instead of fetching from API',
		default: false,
	},
	color: { // --color and FORCE_COLOR=1 is handled by picocolors
		type: 'boolean',
		description: 'Enable colored output (default: auto). FORCE_COLOR=1 has the same effect.',
	},
	noColor: { // --no-color and NO_COLOR=1 is handled by picocolors
		type: 'boolean',
		description: 'Disable colored output (default: auto). NO_COLOR=1 has the same effect.',
	},
	timezone: {
		type: 'string',
		short: 'z',
		description: 'Timezone for date grouping (e.g., UTC, America/New_York, Asia/Tokyo). Default: system timezone',
	},
	locale: {
		type: 'string',
		short: 'l',
		description: 'Locale for date/time formatting (e.g., en-US, ja-JP, de-DE)',
		default: DEFAULT_LOCALE,
	},
	jq: {
		type: 'string',
		short: 'q',
		description: 'Process JSON output with jq command (requires jq binary, implies --json)',
	},
	config: {
		type: 'string',
		description: 'Path to configuration file (default: auto-discovery)',
	},
	compact: {
		type: 'boolean',
		description: 'Force compact mode for narrow displays (better for screenshots)',
		default: false,
	},
} as const satisfies Args;

/**
 * Shared command configuration for Gunshi CLI commands
 */
export const sharedCommandConfig = {
	args: sharedArgs,
	toKebab: true,
} as const;
