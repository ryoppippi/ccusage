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
		description: 'Use cached pricing data instead of fetching from LiteLLM',
		default: false,
		negatable: true,
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
		default: false,
	},
} as const satisfies Args;
