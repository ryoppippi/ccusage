import type { Args } from 'gunshi';
import * as v from 'valibot';

const filterDateRegex = /^\d{8}$/;
const filterDateSchema = v.pipe(
	v.string(),
	v.regex(filterDateRegex, 'Date must be in YYYYMMDD format'),
);

function parseDateArg(value: string): string {
	return v.parse(filterDateSchema, value);
}

export const dateFilterArgs = {
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
} as const satisfies Args;
