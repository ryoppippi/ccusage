import type { DayOfWeek, WeekDay } from './_consts.ts';
/**
 * Date utility functions for handling date formatting, filtering, and manipulation
 * @module date-utils
 */
import type { WeeklyDate } from './_types.ts';
import { sort } from 'fast-sort';
import { DEFAULT_LOCALE } from './_consts.ts';
import { createWeeklyDate, dailyDateSchema } from './_types.ts';
import { unreachable } from './_utils.ts';

/**
 * Sort order for date-based sorting
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Creates a date formatter with the specified timezone and locale
 * @param timezone - Timezone to use (e.g., 'UTC', 'America/New_York')
 * @param locale - Locale to use for formatting (e.g., 'en-US', 'ja-JP')
 * @returns Intl.DateTimeFormat instance
 */
function createDateFormatter(timezone: string | undefined, locale: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
}

/**
 * Creates a date parts formatter with the specified timezone and locale
 * @param timezone - Timezone to use
 * @param locale - Locale to use for formatting
 * @returns Intl.DateTimeFormat instance
 */
function createDatePartsFormatter(timezone: string | undefined, locale: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
}

/**
 * Formats a date string to YYYY-MM-DD format
 * @param dateStr - Input date string
 * @param timezone - Optional timezone to use for formatting
 * @param locale - Optional locale to use for formatting (defaults to DEFAULT_LOCALE for YYYY-MM-DD format)
 * @returns Formatted date string in YYYY-MM-DD format
 */
export function formatDate(dateStr: string, timezone?: string, locale?: string): string {
	const date = new Date(dateStr);
	// Use DEFAULT_LOCALE as default for consistent YYYY-MM-DD format
	const formatter = createDateFormatter(timezone, locale ?? DEFAULT_LOCALE);
	return formatter.format(date);
}

/**
 * Formats a date string to compact format with year on first line and month-day on second
 * @param dateStr - Input date string
 * @param timezone - Timezone to use for formatting (pass undefined to use system timezone)
 * @param locale - Locale to use for formatting
 * @returns Formatted date string with newline separator (YYYY\nMM-DD)
 */
export function formatDateCompact(dateStr: string, timezone: string | undefined, locale: string): string {
	// For YYYY-MM-DD format, append T00:00:00 to parse as local date
	// Without this, new Date('YYYY-MM-DD') interprets as UTC midnight
	const parseResult = dailyDateSchema.safeParse(dateStr);
	const date = parseResult.success
		? timezone != null
			? new Date(`${dateStr}T00:00:00Z`)
			: new Date(`${dateStr}T00:00:00`)
		: new Date(dateStr);
	const formatter = createDatePartsFormatter(timezone, locale);
	const parts = formatter.formatToParts(date);
	const year = parts.find(p => p.type === 'year')?.value ?? '';
	const month = parts.find(p => p.type === 'month')?.value ?? '';
	const day = parts.find(p => p.type === 'day')?.value ?? '';
	return `${year}\n${month}-${day}`;
}

/**
 * Generic function to sort items by date based on sort order
 * @param items - Array of items to sort
 * @param getDate - Function to extract date/timestamp from item
 * @param order - Sort order (asc or desc)
 * @returns Sorted array
 */
export function sortByDate<T>(
	items: T[],
	getDate: (item: T) => string | Date,
	order: SortOrder = 'desc',
): T[] {
	const sorted = sort(items);
	switch (order) {
		case 'desc':
			return sorted.desc(item => new Date(getDate(item)).getTime());
		case 'asc':
			return sorted.asc(item => new Date(getDate(item)).getTime());
		default:
			unreachable(order);
	}
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

		it('should use default locale when locale is not provided', () => {
			const result = formatDate('2024-08-04T12:00:00Z');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('should handle custom locale', () => {
			const result = formatDate('2024-08-04T12:00:00Z', 'UTC', 'en-US');
			expect(result).toBe('08/04/2024');
		});
	});

	describe('formatDateCompact', () => {
		it('should format date to compact format with newline', () => {
			const result = formatDateCompact('2024-08-04', undefined, 'en-US');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle timezone parameter', () => {
			const result = formatDateCompact('2024-08-04T12:00:00Z', 'UTC', 'en-US');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle YYYY-MM-DD format dates', () => {
			const result = formatDateCompact('2024-08-04', undefined, 'en-US');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle timezone with YYYY-MM-DD format', () => {
			const result = formatDateCompact('2024-08-04', 'UTC', 'en-US');
			expect(result).toBe('2024\n08-04');
		});
	});

	describe('sortByDate', () => {
		const testData = [
			{ id: 1, date: '2024-01-01T10:00:00Z' },
			{ id: 2, date: '2024-01-03T10:00:00Z' },
			{ id: 3, date: '2024-01-02T10:00:00Z' },
		];

		it('should sort by date in descending order by default', () => {
			const result = sortByDate(testData, item => item.date);
			expect(result.map(item => item.id)).toEqual([2, 3, 1]);
		});

		it('should sort by date in ascending order when specified', () => {
			const result = sortByDate(testData, item => item.date, 'asc');
			expect(result.map(item => item.id)).toEqual([1, 3, 2]);
		});

		it('should sort by date in descending order when explicitly specified', () => {
			const result = sortByDate(testData, item => item.date, 'desc');
			expect(result.map(item => item.id)).toEqual([2, 3, 1]);
		});

		it('should handle Date objects', () => {
			const dateData = [
				{ id: 1, date: new Date('2024-01-01T10:00:00Z') },
				{ id: 2, date: new Date('2024-01-03T10:00:00Z') },
				{ id: 3, date: new Date('2024-01-02T10:00:00Z') },
			];
			const result = sortByDate(dateData, item => item.date);
			expect(result.map(item => item.id)).toEqual([2, 3, 1]);
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
			const result = filterByDateRange(testData, item => item.date);
			expect(result).toEqual(testData);
		});

		it('should filter by since date', () => {
			const result = filterByDateRange(testData, item => item.date, '20240103');
			expect(result.map(item => item.id)).toEqual([3, 4, 5]);
		});

		it('should filter by until date', () => {
			const result = filterByDateRange(testData, item => item.date, undefined, '20240103');
			expect(result.map(item => item.id)).toEqual([1, 2, 3]);
		});

		it('should filter by both since and until dates', () => {
			const result = filterByDateRange(testData, item => item.date, '20240102', '20240104');
			expect(result.map(item => item.id)).toEqual([2, 3, 4]);
		});

		it('should handle timestamp format dates', () => {
			const timestampData = [
				{ id: 1, date: '2024-01-01T10:00:00Z' },
				{ id: 2, date: '2024-01-02T10:00:00Z' },
				{ id: 3, date: '2024-01-03T10:00:00Z' },
			];
			const result = filterByDateRange(timestampData, item => item.date, '20240102');
			expect(result.map(item => item.id)).toEqual([2, 3]);
		});
	});

	describe('getDateWeek', () => {
		it('should get the first day of week starting from Sunday', () => {
			const date = new Date('2024-01-03T10:00:00Z'); // Wednesday
			const result = getDateWeek(date, 0); // Sunday start
			expect(result.toString().substring(0, 10)).toBe('2023-12-31'); // Previous Sunday
		});

		it('should get the first day of week starting from Monday', () => {
			const date = new Date('2024-01-03T10:00:00Z'); // Wednesday
			const result = getDateWeek(date, 1); // Monday start
			expect(result.toString().substring(0, 10)).toBe('2024-01-01'); // Monday of same week
		});

		it('should handle when the date is already the start of the week', () => {
			const date = new Date('2024-01-01T10:00:00Z'); // Monday
			const result = getDateWeek(date, 1); // Monday start
			expect(result.toString().substring(0, 10)).toBe('2024-01-01'); // Same Monday
		});

		it('should handle Sunday as start of week when date is Sunday', () => {
			const date = new Date('2023-12-31T10:00:00Z'); // Sunday
			const result = getDateWeek(date, 0); // Sunday start
			expect(result.toString().substring(0, 10)).toBe('2023-12-31'); // Same Sunday
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
