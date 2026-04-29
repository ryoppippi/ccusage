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

/**
 * Shared date-range CLI flags for OpenCode reports.
 *
 * Both `since` and `until` accept `YYYYMMDD` strings and use `parseDateArg`
 * for the same format validation before satisfying Gunshi's `Args` shape.
 */
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

if (import.meta.vitest != null) {
	const { describe, expect, it } = import.meta.vitest;

	describe('dateFilterArgs', () => {
		it('should parse main-mode compatible since and until args', () => {
			expect(dateFilterArgs.since.short).toBe('s');
			expect(dateFilterArgs.since.description).toBe('Filter from date (YYYYMMDD format)');
			expect(dateFilterArgs.since.parse('20240102')).toBe('20240102');
			expect(() => dateFilterArgs.since.parse('2024-01-02')).toThrow(
				'Date must be in YYYYMMDD format',
			);

			expect(dateFilterArgs.until.short).toBe('u');
			expect(dateFilterArgs.until.description).toBe('Filter until date (YYYYMMDD format)');
			expect(dateFilterArgs.until.parse('20240103')).toBe('20240103');
			expect(() => dateFilterArgs.until.parse('2024-01-03')).toThrow(
				'Date must be in YYYYMMDD format',
			);
		});
	});
}
