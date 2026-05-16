import type { AgentId, AgentUsageRow } from './types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { agentIds } from './types.ts';

const safeTimeZoneCache = new Map<string, string>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const monthFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateKeyCache = new Map<string, string>();
const monthKeyCache = new Map<string, string>();

export function normalizeDateFilter(value: string | undefined): string | undefined {
	if (value == null || value === '') {
		return undefined;
	}
	if (/^\d{8}$/u.test(value)) {
		return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
	}
	if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		return value;
	}
	throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD or YYYYMMDD.`);
}

export function toCompactDate(value: string | undefined): string | undefined {
	return value?.replaceAll('-', '');
}

export function isWithinRange(
	date: string,
	since: string | undefined,
	until: string | undefined,
): boolean {
	if (since != null && date < since) {
		return false;
	}
	if (until != null && date > until) {
		return false;
	}
	return true;
}

function defaultTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

export function safeTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return defaultTimeZone();
	}

	const cacheKey = timezone.trim();
	const cached = safeTimeZoneCache.get(cacheKey);
	if (cached != null) {
		return cached;
	}

	try {
		Intl.DateTimeFormat('en-US', { timeZone: cacheKey });
		safeTimeZoneCache.set(cacheKey, cacheKey);
		return cacheKey;
	} catch {
		safeTimeZoneCache.set(cacheKey, 'UTC');
		return 'UTC';
	}
}

function getDateFormatter(timezone: string): Intl.DateTimeFormat {
	const cached = dateFormatterCache.get(timezone);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
	dateFormatterCache.set(timezone, formatter);
	return formatter;
}

function getMonthFormatter(timezone: string): Intl.DateTimeFormat {
	const cached = monthFormatterCache.get(timezone);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		timeZone: timezone,
	});
	monthFormatterCache.set(timezone, formatter);
	return formatter;
}

function getDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
	const cached = dateTimeFormatterCache.get(timezone);
	if (cached != null) {
		return cached;
	}

	const formatter = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'short',
		timeStyle: 'short',
		timeZone: timezone,
	});
	dateTimeFormatterCache.set(timezone, formatter);
	return formatter;
}

export function formatDateKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const cacheKey = `${tz}:${timestamp.slice(0, 13)}`;
	const cached = dateKeyCache.get(cacheKey);
	if (cached != null) {
		return cached;
	}

	const formatted = getDateFormatter(tz).format(new Date(timestamp));
	dateKeyCache.set(cacheKey, formatted);
	return formatted;
}

export function formatMonthKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const cacheKey = `${tz}:${timestamp.slice(0, 13)}`;
	const cached = monthKeyCache.get(cacheKey);
	if (cached != null) {
		return cached;
	}

	const [year, month] = getMonthFormatter(tz).format(new Date(timestamp)).split('-');
	const formatted = `${year}-${month}`;
	monthKeyCache.set(cacheKey, formatted);
	return formatted;
}

export function formatDateTime(timestamp: string, timezone?: string): string {
	return getDateTimeFormatter(safeTimeZone(timezone)).format(new Date(timestamp));
}

export function createEmptyRow(period: string, agent: AgentId | 'all'): AgentUsageRow {
	return {
		period,
		agent,
		modelsUsed: [],
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		totalCost: 0,
	};
}

export function getRowAgents(row: AgentUsageRow): AgentId[] {
	const agents = row.metadata?.agents;
	if (Array.isArray(agents)) {
		return agents.filter((agent): agent is AgentId => agentIds.includes(agent as AgentId));
	}
	return row.agent === 'all' ? [] : [row.agent];
}

export function sortRows(rows: AgentUsageRow[]): AgentUsageRow[] {
	return rows.sort(
		(a, b) => compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent),
	);
}

if (import.meta.vitest != null) {
	describe('adapter date formatting', () => {
		it('formats cached date and month keys', () => {
			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'UTC')).toBe('2026-05-16');
			expect(formatMonthKey('2026-05-16T12:34:56.000Z', 'UTC')).toBe('2026-05');
			expect(formatDateKey('2026-05-16T23:34:56.000Z', 'Asia/Tokyo')).toBe('2026-05-17');
		});

		it('falls back to UTC for invalid timezones', () => {
			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'Invalid/Zone')).toBe('2026-05-16');
		});
	});
}
