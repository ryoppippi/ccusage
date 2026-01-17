const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
const TIMEZONE_CACHE = new Map<string, string>();
const DATE_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const MONTH_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function safeTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return DEFAULT_TIMEZONE;
	}

	const trimmed = timezone.trim();
	const cached = TIMEZONE_CACHE.get(trimmed);
	if (cached != null) {
		return cached;
	}

	try {
		// Validate timezone by creating a formatter
		Intl.DateTimeFormat('en-US', { timeZone: trimmed });
		TIMEZONE_CACHE.set(trimmed, trimmed);
		return trimmed;
	} catch {
		TIMEZONE_CACHE.set(trimmed, 'UTC');
		return 'UTC';
	}
}

function getDateKeyFormatter(timezone?: string): Intl.DateTimeFormat {
	const tz = safeTimeZone(timezone);
	const cached = DATE_KEY_FORMATTER_CACHE.get(tz);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: tz,
	});
	DATE_KEY_FORMATTER_CACHE.set(tz, formatter);
	return formatter;
}

function getMonthKeyFormatter(timezone?: string): Intl.DateTimeFormat {
	const tz = safeTimeZone(timezone);
	const cached = MONTH_KEY_FORMATTER_CACHE.get(tz);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		timeZone: tz,
	});
	MONTH_KEY_FORMATTER_CACHE.set(tz, formatter);
	return formatter;
}

export function toDateKey(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	return getDateKeyFormatter(timezone).format(date);
}

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

export function formatDisplayDate(dateKey: string, locale?: string, _timezone?: string): string {
	// dateKey is already computed for the target timezone via toDateKey().
	// Treat it as a plain calendar date and avoid shifting it by applying a timezone.
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

export function toMonthKey(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	const [year, month] = getMonthKeyFormatter(timezone).format(date).split('-');
	return `${year}-${month}`;
}

export function formatDisplayMonth(monthKey: string, locale?: string, _timezone?: string): string {
	// monthKey is already derived in the target timezone via toMonthKey().
	// Render it as a calendar month without shifting by timezone.
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
