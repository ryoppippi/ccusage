/**
 * Date utility functions for handling date formatting, filtering, and manipulation
 * @module date-utils
 */

import type { DayOfWeek, WeekDay } from './_consts.ts';
import type { WeeklyDate } from './_types.ts';
import { DEFAULT_LOCALE } from './_consts.ts';
import { createWeeklyDate } from './_types.ts';

export { sortByDate } from '@ccusage/internal/sort';
// Re-export formatDateCompact from shared package
export { formatDateCompact } from '@ccusage/terminal/table';

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatDateParts(year: number, month: number, day: number): string {
	return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function formatLocalDate(date: Date): string {
	return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function formatUTCDate(date: Date): string {
	return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function createDateFormatter(timezone: string | undefined): Intl.DateTimeFormat {
	const cacheKey = timezone ?? '';
	const cached = dateFormatterCache.get(cacheKey);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
	dateFormatterCache.set(cacheKey, formatter);
	return formatter;
}

/**
 * Formats a date string to YYYY-MM-DD format
 * @param dateStr - Input date string
 * @param timezone - Optional timezone to use for formatting
 * @returns Formatted date string in YYYY-MM-DD format
 */
export function formatDate(dateStr: string, timezone?: string): string {
	const date = new Date(dateStr);
	if (timezone == null) {
		return formatLocalDate(date);
	}
	if (timezone === 'UTC') {
		return formatUTCDate(date);
	}
	const formatter = createDateFormatter(timezone);
	return formatter.format(date);
}

export function createCachedDateFormatter(timezone?: string): (dateStr: string) => string {
	if (timezone == null) {
		const cache = new Map<string, string>();
		return (dateStr: string): string => {
			const cacheKey = dateStr.slice(0, 13);
			const cached = cache.get(cacheKey);
			if (cached != null) {
				return cached;
			}
			const formatted = formatLocalDate(new Date(dateStr));
			cache.set(cacheKey, formatted);
			return formatted;
		};
	}

	if (timezone === 'UTC') {
		const cache = new Map<string, string>();
		return (dateStr: string): string => {
			const cacheKey = dateStr.slice(0, 13);
			const cached = cache.get(cacheKey);
			if (cached != null) {
				return cached;
			}
			const formatted = formatUTCDate(new Date(dateStr));
			cache.set(cacheKey, formatted);
			return formatted;
		};
	}

	const formatter = createDateFormatter(timezone);
	const cache = new Map<string, string>();
	return (dateStr: string): string => {
		const cacheKey = dateStr.slice(0, 13);
		const cached = cache.get(cacheKey);
		if (cached != null) {
			return cached;
		}
		const formatted = formatter.format(new Date(dateStr));
		cache.set(cacheKey, formatted);
		return formatted;
	};
}

/**
 * Filters items by date range
 * @param items - Array of items to filter
 * @param getDate - Function to extract date string from item
 * @param since - Start date in any format (will be converted to YYYYMMDD for comparison)
 * @param until - End date in any format (will be converted to YYYYMMDD for comparison)
 * @returns Filtered array
 */
export function filterByDateRange<T>(
	items: T[],
	getDate: (item: T) => string,
	since?: string,
	until?: string,
): T[] {
	if (since == null && until == null) {
		return items;
	}

	return items.filter((item) => {
		const dateStr = getDate(item).substring(0, 10).replace(/-/g, ''); // Convert to YYYYMMDD
		if (since != null && dateStr < since) {
			return false;
		}
		if (until != null && dateStr > until) {
			return false;
		}
		return true;
	});
}

/**
 * Get the first day of the week for a given date
 * @param date - The date to get the week for
 * @param startDay - The day to start the week on (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 * @returns The date of the first day of the week for the given date
 */
export function getDateWeek(date: Date, startDay: DayOfWeek): WeeklyDate {
	const d = new Date(date);
	const day = d.getDay();
	const shift = (day - startDay + 7) % 7;
	d.setDate(d.getDate() - shift);

	return createWeeklyDate(d.toISOString().substring(0, 10));
}

/**
 * Get the first day of the week for an existing YYYY-MM-DD daily bucket key.
 *
 * This preserves `getDateWeek(new Date(date), startDay)` semantics while avoiding the extra Date
 * clone inside `getDateWeek` when weekly aggregation is already working from daily strings.
 */
export function getDateStringWeek(date: string, startDay: DayOfWeek): WeeklyDate {
	const d = new Date(date);
	const day = d.getDay();
	const shift = (day - startDay + 7) % 7;
	d.setDate(d.getDate() - shift);

	return createWeeklyDate(d.toISOString().substring(0, 10));
}

/**
 * Convert day name to number (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 * @param day - Day name
 * @returns Day number
 */
export function getDayNumber(day: WeekDay): DayOfWeek {
	const dayMap = {
		sunday: 0,
		monday: 1,
		tuesday: 2,
		wednesday: 3,
		thursday: 4,
		friday: 5,
		saturday: 6,
	} as const satisfies Record<WeekDay, DayOfWeek>;
	return dayMap[day];
}

if (import.meta.vitest != null) {
	describe('formatDate', () => {
		it('should format date string to YYYY-MM-DD format', () => {
			const result = formatDate('2024-08-04T12:00:00Z');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('should handle timezone parameter', () => {
			const result = formatDate('2024-08-04T12:00:00Z', 'UTC');
			expect(result).toBe('2024-08-04');
		});

		it('uses the default YYYY-MM-DD locale', () => {
			const result = formatDate('2024-08-04T12:00:00Z');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});

	describe('filterByDateRange', () => {
		const testData = [
			{ id: 1, date: '2024-01-01' },
			{ id: 2, date: '2024-01-02' },
			{ id: 3, date: '2024-01-03' },
			{ id: 4, date: '2024-01-04' },
			{ id: 5, date: '2024-01-05' },
		];

		it('should return all items when no date filters are provided', () => {
			const result = filterByDateRange(testData, (item) => item.date);
			expect(result).toEqual(testData);
		});

		it('should filter by since date', () => {
			const result = filterByDateRange(testData, (item) => item.date, '20240103');
			expect(result.map((item) => item.id)).toEqual([3, 4, 5]);
		});

		it('should filter by until date', () => {
			const result = filterByDateRange(testData, (item) => item.date, undefined, '20240103');
			expect(result.map((item) => item.id)).toEqual([1, 2, 3]);
		});

		it('should filter by both since and until dates', () => {
			const result = filterByDateRange(testData, (item) => item.date, '20240102', '20240104');
			expect(result.map((item) => item.id)).toEqual([2, 3, 4]);
		});

		it('should handle timestamp format dates', () => {
			const timestampData = [
				{ id: 1, date: '2024-01-01T10:00:00Z' },
				{ id: 2, date: '2024-01-02T10:00:00Z' },
				{ id: 3, date: '2024-01-03T10:00:00Z' },
			];
			const result = filterByDateRange(timestampData, (item) => item.date, '20240102');
			expect(result.map((item) => item.id)).toEqual([2, 3]);
		});
	});

	describe('getDateWeek', () => {
		it('should get the first day of week starting from Sunday', () => {
			const date = new Date('2024-01-03T10:00:00Z'); // Wednesday
			const result = getDateWeek(date, 0); // Sunday start
			expect(result).toBe(createWeeklyDate('2023-12-31')); // Previous Sunday
		});

		it('should get the first day of week starting from Monday', () => {
			const date = new Date('2024-01-03T10:00:00Z'); // Wednesday
			const result = getDateWeek(date, 1); // Monday start
			expect(result).toBe(createWeeklyDate('2024-01-01')); // Monday of same week
		});

		it('should handle when the date is already the start of the week', () => {
			const date = new Date('2024-01-01T10:00:00Z'); // Monday
			const result = getDateWeek(date, 1); // Monday start
			expect(result).toBe(createWeeklyDate('2024-01-01')); // Same Monday
		});

		it('should handle Sunday as start of week when date is Sunday', () => {
			const date = new Date('2023-12-31T10:00:00Z'); // Sunday
			const result = getDateWeek(date, 0); // Sunday start
			expect(result).toBe(createWeeklyDate('2023-12-31')); // Same Sunday
		});
	});

	describe('getDateStringWeek', () => {
		it('matches getDateWeek for daily usage date strings', () => {
			const dates = ['2023-12-31', '2024-01-01', '2024-01-03', '2024-01-07'];

			for (const date of dates) {
				expect(getDateStringWeek(date, 0)).toBe(getDateWeek(new Date(date), 0));
				expect(getDateStringWeek(date, 1)).toBe(getDateWeek(new Date(date), 1));
			}
		});
	});

	describe('getDayNumber', () => {
		it('should convert day names to correct numbers', () => {
			expect(getDayNumber('sunday')).toBe(0);
			expect(getDayNumber('monday')).toBe(1);
			expect(getDayNumber('tuesday')).toBe(2);
			expect(getDayNumber('wednesday')).toBe(3);
			expect(getDayNumber('thursday')).toBe(4);
			expect(getDayNumber('friday')).toBe(5);
			expect(getDayNumber('saturday')).toBe(6);
		});
	});
}
