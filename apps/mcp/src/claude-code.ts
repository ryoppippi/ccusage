import type { calculateTotals } from 'ccusage/calculate-cost';
import type { LoadOptions } from 'ccusage/data-loader';
import { createTotalsObject } from 'ccusage/calculate-cost';
import { getClaudePaths } from 'ccusage/data-loader';
import { z } from 'zod';
import { DATE_FILTER_REGEX } from './consts.ts';

export const filterDateSchema = z.string()
	.regex(DATE_FILTER_REGEX, 'Date must be in YYYYMMDD format');

export function transformUsageDataWithTotals<T>(
	data: T[],
	totals: ReturnType<typeof calculateTotals>,
	mapper: (item: T) => unknown,
	key: string,
): { [K in string]: unknown } & { totals: ReturnType<typeof createTotalsObject> } {
	return {
		[key]: data.map(mapper),
		totals: createTotalsObject(totals),
	};
}

export function defaultOptions(): LoadOptions {
	const paths = getClaudePaths();
	if (paths.length === 0) {
		throw new Error('No valid Claude path found. Ensure getClaudePaths() returns at least one valid path.');
	}
	return { claudePath: paths[0] } as const satisfies LoadOptions;
}
