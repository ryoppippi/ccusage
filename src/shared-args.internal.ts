import type { Args } from 'gunshi';
import type { CostMode, SortOrder } from './types.internal.ts';
import * as v from 'valibot';
import { CostModes, dateSchema, SortOrders } from './types.internal.ts';

function parseDateArg(value: string): string {
	const result = v.safeParse(dateSchema, value);
	if (!result.success) {
		throw new TypeError(result.issues[0].message);
	}
	return result.output;
}

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
} as const satisfies Args;

export const sharedCommandConfig = {
	args: sharedArgs,
	toKebab: true,
} as const;
