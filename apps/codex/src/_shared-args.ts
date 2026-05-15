import type { Args } from 'gunshi';

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
	},
	offline: {
		type: 'boolean',
		short: 'O',
		description: 'Use cached pricing data instead of fetching from LiteLLM',
		default: false,
		negatable: true,
	},
	speed: {
		type: 'string',
		description:
			'Cost speed tier: auto reads Codex config.toml service_tier; use standard or fast to override',
		default: 'auto',
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
		default: false,
	},
	color: {
		// --color and FORCE_COLOR=1 are handled by the shared styleText color helper
		type: 'boolean',
		description: 'Enable colored output (default: auto). FORCE_COLOR=1 has the same effect.',
	},
	noColor: {
		// --no-color and NO_COLOR=1 are handled by the shared styleText color helper
		type: 'boolean',
		description: 'Disable colored output (default: auto). NO_COLOR=1 has the same effect.',
	},
} as const satisfies Args;
