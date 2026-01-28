/**
 * @fileoverview Date utility functions for OpenCode usage analysis
 *
 * This module provides functions for date comparison and filtering
 * used across all command implementations.
 *
 * @module date-utils
 */

/**
 * Parse a date string in YYYYMMDD format to a Date object
 * @param dateStr - Date string in YYYYMMDD format
 * @returns Date object or null if invalid
 */
function parseYYYYMMDD(dateStr: string): Date | null {
	if (dateStr.length !== 8) {
		return null;
	}

	const year = Number.parseInt(dateStr.slice(0, 4), 10);
	const month = Number.parseInt(dateStr.slice(4, 6), 10) - 1; // Month is 0-indexed
	const day = Number.parseInt(dateStr.slice(6, 8), 10);

	if (
		Number.isNaN(year) ||
		Number.isNaN(month) ||
		Number.isNaN(day) ||
		month < 0 ||
		month > 11 ||
		day < 1 ||
		day > 31
	) {
		return null;
	}

	const date = new Date(year, month, day);
	// Check if the date is valid (e.g., not Feb 30)
	if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
		return null;
	}

	return date;
}

/**
 * Check if a date is within the specified range
 * @param date - Date to check
 * @param since - Start date in YYYYMMDD format (inclusive), or null for no lower bound
 * @param until - End date in YYYYMMDD format (inclusive), or null for no upper bound
 * @returns true if date is within range, false otherwise
 */
export function isDateInRange(date: Date, since: string | null, until: string | null): boolean {
	// Normalize date to midnight UTC for consistent comparison
	const normalizedDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

	if (since != null) {
		const sinceDate = parseYYYYMMDD(since);
		if (sinceDate == null) {
			return false;
		}
		const normalizedSince = new Date(
			Date.UTC(sinceDate.getFullYear(), sinceDate.getMonth(), sinceDate.getDate()),
		);
		if (normalizedDate < normalizedSince) {
			return false;
		}
	}

	if (until != null) {
		const untilDate = parseYYYYMMDD(until);
		if (untilDate == null) {
			return false;
		}
		const normalizedUntil = new Date(
			Date.UTC(untilDate.getFullYear(), untilDate.getMonth(), untilDate.getDate()),
		);
		if (normalizedDate > normalizedUntil) {
			return false;
		}
	}

	return true;
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('date-utils', () => {
		describe('parseYYYYMMDD', () => {
			it('should parse valid dates', () => {
				const date = parseYYYYMMDD('20250128');
				expect(date).not.toBeNull();
				expect(date?.getFullYear()).toBe(2025);
				expect(date?.getMonth()).toBe(0); // January
				expect(date?.getDate()).toBe(28);
			});

			it('should handle leap years', () => {
				const date = parseYYYYMMDD('20240229');
				expect(date).not.toBeNull();
				expect(date?.getFullYear()).toBe(2024);
				expect(date?.getMonth()).toBe(1); // February
				expect(date?.getDate()).toBe(29);
			});

			it('should reject invalid dates', () => {
				expect(parseYYYYMMDD('20240230')).toBeNull(); // Feb 30 doesn't exist
				expect(parseYYYYMMDD('20241301')).toBeNull(); // Month 13
				expect(parseYYYYMMDD('20240001')).toBeNull(); // Month 0
				expect(parseYYYYMMDD('20240132')).toBeNull(); // Day 32
				expect(parseYYYYMMDD('20240100')).toBeNull(); // Day 0
				expect(parseYYYYMMDD('202501')).toBeNull(); // Too short
				expect(parseYYYYMMDD('202501281')).toBeNull(); // Too long
				expect(parseYYYYMMDD('abcd0128')).toBeNull(); // Non-numeric
			});
		});

		describe('isDateInRange', () => {
			it('should accept dates within range', () => {
				const date = new Date('2025-01-15T12:00:00Z');
				expect(isDateInRange(date, '20250110', '20250120')).toBe(true);
			});

			it('should accept dates on boundaries', () => {
				const date1 = new Date('2025-01-10T00:00:00Z');
				const date2 = new Date('2025-01-20T23:59:59Z');
				expect(isDateInRange(date1, '20250110', '20250120')).toBe(true);
				expect(isDateInRange(date2, '20250110', '20250120')).toBe(true);
			});

			it('should reject dates before since', () => {
				const date = new Date('2025-01-09T23:59:59Z');
				expect(isDateInRange(date, '20250110', '20250120')).toBe(false);
			});

			it('should reject dates after until', () => {
				const date = new Date('2025-01-21T00:00:01Z');
				expect(isDateInRange(date, '20250110', '20250120')).toBe(false);
			});

			it('should accept all dates when since is null', () => {
				const date1 = new Date('2025-01-01T00:00:00Z');
				const date2 = new Date('2025-01-20T23:59:59Z');
				expect(isDateInRange(date1, null, '20250120')).toBe(true);
				expect(isDateInRange(date2, null, '20250120')).toBe(true);
			});

			it('should accept all dates when until is null', () => {
				const date1 = new Date('2025-01-10T00:00:00Z');
				const date2 = new Date('2025-12-31T23:59:59Z');
				expect(isDateInRange(date1, '20250110', null)).toBe(true);
				expect(isDateInRange(date2, '20250110', null)).toBe(true);
			});

			it('should accept all dates when both are null', () => {
				const date = new Date('2025-01-15T12:00:00Z');
				expect(isDateInRange(date, null, null)).toBe(true);
			});

			it('should handle different timezones correctly', () => {
				// Create dates in different timezones
				const date1 = new Date('2025-01-15T00:00:00-05:00'); // 5:00 UTC
				const date2 = new Date('2025-01-15T23:59:59+05:00'); // 18:59 UTC
				// Both should be accepted as they're on the same day in UTC
				expect(isDateInRange(date1, '20250115', '20250115')).toBe(true);
				expect(isDateInRange(date2, '20250115', '20250115')).toBe(true);
			});

			it('should reject invalid since date', () => {
				const date = new Date('2025-01-15T12:00:00Z');
				expect(isDateInRange(date, '20241301', '20250120')).toBe(false);
			});

			it('should reject invalid until date', () => {
				const date = new Date('2025-01-15T12:00:00Z');
				expect(isDateInRange(date, '20250110', '20240230')).toBe(false);
			});
		});
	});
}
