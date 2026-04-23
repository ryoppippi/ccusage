/**
 * @fileoverview Date utilities for timezone-aware grouping and filtering
 */

function safeTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	}

	try {
		Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return timezone;
	} catch {
		return 'UTC';
	}
}

/**
 * Convert a timestamp to a YYYY-MM-DD date key in the given timezone
 */
export function toDateKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: tz,
	});
	return formatter.format(date);
}

/**
 * Convert a timestamp to a YYYY-MM month key in the given timezone
 */
export function toMonthKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const year = new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: tz }).format(date);
	const month = new Intl.DateTimeFormat('en-US', { month: '2-digit', timeZone: tz }).format(date);
	return `${year}-${month}`;
}

/**
 * Normalize a filter date from YYYYMMDD or YYYY-MM-DD to YYYY-MM-DD
 */
export function normalizeFilterDate(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}

	const compact = value.replaceAll('-', '').trim();

	// Accept YYYY-MM format (6 digits)
	if (/^\d{6}$/.test(compact)) {
		return `${compact.slice(0, 4)}-${compact.slice(4, 6)}`;
	}

	// Accept YYYY-MM-DD or YYYYMMDD format (8 digits)
	if (/^\d{8}$/.test(compact)) {
		return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
	}

	throw new Error(`Invalid date format: ${value}. Expected YYYY-MM-DD, YYYY-MM, or YYYYMMDD.`);
}

/**
 * Expand a YYYY-MM until bound to YYYY-MM-31 for day-level comparisons.
 * Full YYYY-MM-DD values pass through unchanged.
 */
export function expandUntilForDayComparison(until?: string): string | undefined {
	if (until == null) {
		return undefined;
	}
	// YYYY-MM (7 chars) needs padding for day-level comparison
	if (/^\d{4}-\d{2}$/.test(until)) {
		return `${until}-31`;
	}
	return until;
}

/**
 * Check if a date key falls within a range (inclusive)
 */
export function isWithinRange(dateKey: string, since?: string, until?: string): boolean {
	if (since != null && dateKey < since) {
		return false;
	}
	if (until != null && dateKey > until) {
		return false;
	}
	return true;
}

/**
 * Format a date key for display using locale
 */
export function formatDisplayDate(dateKey: string, locale?: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(`${dateKey}T00:00:00`);
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		timeZone: tz,
	});
	return formatter.format(date);
}

/**
 * Format a month key for display using locale
 */
export function formatDisplayMonth(monthKey: string, locale?: string): string {
	const [yearStr = '0', monthStr = '1'] = monthKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const date = new Date(Date.UTC(year, month - 1, 1));
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		timeZone: 'UTC',
	});
	return formatter.format(date);
}

if (import.meta.vitest != null) {
	describe('normalizeFilterDate', () => {
		it('normalizes YYYYMMDD to YYYY-MM-DD', () => {
			expect(normalizeFilterDate('20260315')).toBe('2026-03-15');
		});

		it('passes through YYYY-MM-DD', () => {
			expect(normalizeFilterDate('2026-03-15')).toBe('2026-03-15');
		});

		it('normalizes YYYY-MM to YYYY-MM', () => {
			expect(normalizeFilterDate('2026-04')).toBe('2026-04');
		});

		it('returns undefined for undefined input', () => {
			expect(normalizeFilterDate(undefined)).toBeUndefined();
		});

		it('throws on invalid format', () => {
			expect(() => normalizeFilterDate('2026-3')).toThrow('Invalid date format');
		});
	});

	describe('expandUntilForDayComparison', () => {
		it('expands YYYY-MM to YYYY-MM-31', () => {
			expect(expandUntilForDayComparison('2026-04')).toBe('2026-04-31');
		});

		it('passes through YYYY-MM-DD unchanged', () => {
			expect(expandUntilForDayComparison('2026-04-15')).toBe('2026-04-15');
		});

		it('returns undefined for undefined', () => {
			expect(expandUntilForDayComparison(undefined)).toBeUndefined();
		});
	});

	describe('toDateKey', () => {
		it('converts UTC timestamp to date key in UTC', () => {
			expect(toDateKey('2026-03-15T10:00:00Z', 'UTC')).toBe('2026-03-15');
		});

		it('handles timezone offset at day boundary', () => {
			// 2026-03-31T20:00Z is April 1 in Asia/Kolkata (UTC+5:30)
			expect(toDateKey('2026-03-31T20:00:00Z', 'Asia/Kolkata')).toBe('2026-04-01');
		});
	});

	describe('toMonthKey', () => {
		it('converts timestamp to month key', () => {
			expect(toMonthKey('2026-03-15T10:00:00Z', 'UTC')).toBe('2026-03');
		});

		it('handles timezone offset at month boundary', () => {
			expect(toMonthKey('2026-03-31T20:00:00Z', 'Asia/Kolkata')).toBe('2026-04');
		});
	});

	describe('isWithinRange', () => {
		it('returns true when in range', () => {
			expect(isWithinRange('2026-03-15', '2026-03-01', '2026-03-31')).toBe(true);
		});

		it('returns false when before since', () => {
			expect(isWithinRange('2026-02-28', '2026-03-01', '2026-03-31')).toBe(false);
		});

		it('returns false when after until', () => {
			expect(isWithinRange('2026-04-01', '2026-03-01', '2026-03-31')).toBe(false);
		});

		it('returns true when no bounds', () => {
			expect(isWithinRange('2026-03-15')).toBe(true);
		});

		it('inclusive boundaries', () => {
			expect(isWithinRange('2026-03-01', '2026-03-01', '2026-03-31')).toBe(true);
			expect(isWithinRange('2026-03-31', '2026-03-01', '2026-03-31')).toBe(true);
		});
	});
}
