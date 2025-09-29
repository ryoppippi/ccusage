import type { Args } from 'gunshi';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE } from './_consts.ts';

export const sharedArgs = {
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output report as JSON',
		default: false,
	},
	since: {
		type: 'string',
		short: 's',
		description: 'Filter from date (YYYY-MM-DD or YYYYMMDD)',
	},
	until: {
		type: 'string',
		short: 'u',
		description: 'Filter until date (inclusive)',
	},
	timezone: {
		type: 'string',
		short: 'z',
		description: 'Timezone for date grouping (IANA)',
		default: DEFAULT_TIMEZONE,
	},
	locale: {
		type: 'string',
		short: 'l',
		description: 'Locale for formatting',
		default: DEFAULT_LOCALE,
	},
	offline: {
		type: 'boolean',
		short: 'O',
		description: 'Use cached pricing data instead of fetching from external source',
		default: false,
		negatable: true,
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
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
} as const satisfies Args;
