/**
 * @fileoverview Date utilities for grouping Factory Droid events.
 *
 * Input timestamps are ISO strings from logs; these helpers normalize them into
 * date/month keys and format display labels.
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
 * Converts a timestamp into a `YYYY-MM-DD` key in the given timezone.
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
 * Converts a timestamp into a `YYYY-MM` key in the given timezone.
 */
export function toMonthKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		timeZone: tz,
	});
	const [year, month] = formatter.format(date).split('-');
	return `${year}-${month}`;
}

/**
 * Normalizes filter inputs into `YYYY-MM-DD`.
 *
 * Accepts `YYYYMMDD` or `YYYY-MM-DD`.
 */
export function normalizeFilterDate(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}

	const compact = value.replaceAll('-', '').trim();
	if (!/^\d{8}$/.test(compact)) {
		throw new Error(`Invalid date format: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`);
	}

	return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * Returns true if `dateKey` (YYYY-MM-DD) is within the inclusive range.
 */
export function isWithinRange(dateKey: string, since?: string, until?: string): boolean {
	const value = dateKey.replaceAll('-', '');
	const sinceValue = since?.replaceAll('-', '');
	const untilValue = until?.replaceAll('-', '');

	if (sinceValue != null && value < sinceValue) {
		return false;
	}

	if (untilValue != null && value > untilValue) {
		return false;
	}

	return true;
}

/**
 * Formats a `YYYY-MM-DD` key for display (timezone-independent).
 */
export function formatDisplayDate(dateKey: string, locale?: string, _timezone?: string): string {
	const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		timeZone: 'UTC',
	});
	return formatter.format(date);
}

/**
 * Formats a `YYYY-MM` key for display (timezone-independent).
 */
export function formatDisplayMonth(monthKey: string, locale?: string, _timezone?: string): string {
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

/**
 * Formats an ISO timestamp for display in a given timezone.
 */
export function formatDisplayDateTime(
	timestamp: string,
	locale?: string,
	timezone?: string,
): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		dateStyle: 'short',
		timeStyle: 'short',
		timeZone: tz,
	});
	return formatter.format(date);
}
