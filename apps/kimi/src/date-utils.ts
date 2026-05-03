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
 * Get ISO week key for a timestamp
 * ISO week starts on Monday, first week contains Jan 4th
 * @param timestamp - ISO timestamp string
 * @param timezone - Optional timezone (defaults to local)
 * @returns Week string in format YYYY-Www (e.g., "2025-W24")
 */
export function toWeekKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const d = new Date(timestamp);

	// Create a formatter that gives us date components in the target timezone
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		timeZone: tz,
	});

	const parts = formatter.formatToParts(d);
	const year = Number.parseInt(parts.find((p) => p.type === 'year')?.value ?? '0', 10);
	const month = Number.parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10);
	const day = Number.parseInt(parts.find((p) => p.type === 'day')?.value ?? '1', 10);

	// Create date in UTC to avoid timezone shifts affecting calculations
	const date = new Date(Date.UTC(year, month - 1, day));

	// Get day of week (0 = Sunday, 1 = Monday, etc.)
	const dayNum = date.getUTCDay() || 7; // Make Sunday 7 instead of 0

	// Set to nearest Thursday: current date + 4 - current day number
	// This puts us in the correct ISO week year
	const thursday = new Date(date);
	thursday.setUTCDate(date.getUTCDate() + 4 - dayNum);

	// Get the year of this Thursday
	const thursdayYear = thursday.getUTCFullYear();

	// Get first day of that year
	const yearStart = new Date(Date.UTC(thursdayYear, 0, 1));

	// Get day of week for year start
	const yearStartDay = yearStart.getUTCDay() || 7;

	// Calculate days from year start to first Thursday (which is in week 1)
	const daysToFirstThursday = (4 - yearStartDay + 7) % 7;
	const firstThursday = new Date(yearStart);
	firstThursday.setUTCDate(yearStart.getUTCDate() + daysToFirstThursday);

	// Calculate week number
	const msPerDay = 24 * 60 * 60 * 1000;
	const weekNo = Math.floor((thursday.getTime() - firstThursday.getTime()) / (7 * msPerDay)) + 1;

	return `${thursdayYear}-W${String(weekNo).padStart(2, '0')}`;
}

export function formatDisplayWeek(weekKey: string): string {
	return weekKey;
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
