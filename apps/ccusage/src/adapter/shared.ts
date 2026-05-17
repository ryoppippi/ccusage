import type {
	AdapterContext,
	AdapterOptions,
	AgentId,
	AgentUsageRow,
	ReportKind,
} from './types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { agentIds } from './types.ts';

const safeTimeZoneCache = new Map<string, string>();
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const monthFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateKeyCache = new Map<string, string>();
const monthKeyCache = new Map<string, string>();
let defaultTimeZoneCache: string | undefined;
const isoUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T.*Z$/u;
const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/u;
const monthKeyPattern = /^\d{4}-\d{2}$/u;

function formatDateParts(year: number, month: number, day: number): string {
	return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function formatLocalDateKey(date: Date): string {
	return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function formatUTCDateKey(date: Date): string {
	return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function formatLocalMonthKey(date: Date): string {
	return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
}

function formatUTCMonthKey(date: Date): string {
	return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}`;
}

export function normalizeDateFilter(value: string | undefined): string | undefined {
	if (value == null || value === '') {
		return undefined;
	}
	const normalized = /^\d{8}$/u.test(value)
		? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
		: /^\d{4}-\d{2}-\d{2}$/u.test(value)
			? value
			: undefined;
	if (normalized != null && isValidCalendarDate(normalized)) {
		return normalized;
	}
	throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD or YYYYMMDD.`);
}

function isValidCalendarDate(value: string): boolean {
	const [year, month, day] = value.split('-').map(Number);
	if (year == null || month == null || day == null) {
		return false;
	}
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
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
	defaultTimeZoneCache ??= Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	return defaultTimeZoneCache;
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
	if (timezone == null || timezone.trim() === '') {
		const cacheKey = `local:${timestamp.slice(0, 13)}`;
		const cached = dateKeyCache.get(cacheKey);
		if (cached != null) {
			return cached;
		}
		const formatted = formatLocalDateKey(new Date(timestamp));
		dateKeyCache.set(cacheKey, formatted);
		return formatted;
	}

	const tz = safeTimeZone(timezone);
	if (tz === 'UTC' && isoUtcTimestampPattern.test(timestamp)) {
		return timestamp.slice(0, 10);
	}
	const date = new Date(timestamp);
	if (tz === 'UTC') {
		return formatUTCDateKey(date);
	}
	const formatter = getDateFormatter(tz);
	const formatted = formatDateKeyWithFormatter(formatter, date);
	const cacheKey = `${tz}:${formatted}`;
	const cached = dateKeyCache.get(cacheKey);
	if (cached != null) {
		return cached;
	}

	dateKeyCache.set(cacheKey, formatted);
	return formatted;
}

export function formatMonthKey(timestamp: string, timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		const cacheKey = `local:${timestamp.slice(0, 13)}`;
		const cached = monthKeyCache.get(cacheKey);
		if (cached != null) {
			return cached;
		}
		const formatted = formatLocalMonthKey(new Date(timestamp));
		monthKeyCache.set(cacheKey, formatted);
		return formatted;
	}

	const tz = safeTimeZone(timezone);
	if (tz === 'UTC' && isoUtcTimestampPattern.test(timestamp)) {
		return timestamp.slice(0, 7);
	}
	const date = new Date(timestamp);
	if (tz === 'UTC') {
		return formatUTCMonthKey(date);
	}
	const formatter = getMonthFormatter(tz);
	const formatted = formatMonthKeyWithFormatter(formatter, date);
	const cacheKey = `${tz}:${formatted}`;
	const cached = monthKeyCache.get(cacheKey);
	if (cached != null) {
		return cached;
	}

	monthKeyCache.set(cacheKey, formatted);
	return formatted;
}

function formatDateKeyWithFormatter(formatter: Intl.DateTimeFormat, date: Date): string {
	const formatted = formatter.format(date);
	if (dateKeyPattern.test(formatted)) {
		return formatted;
	}
	const { year, month, day } = getDateParts(formatter, date);
	return `${year}-${month}-${day}`;
}

function formatMonthKeyWithFormatter(formatter: Intl.DateTimeFormat, date: Date): string {
	const formatted = formatter.format(date);
	if (monthKeyPattern.test(formatted)) {
		return formatted;
	}
	const { year, month } = getDateParts(formatter, date);
	return `${year}-${month}`;
}

function getDateParts(
	formatter: Intl.DateTimeFormat,
	date: Date,
): {
	year: string;
	month: string;
	day?: string;
} {
	let year: string | undefined;
	let month: string | undefined;
	let day: string | undefined;
	for (const part of formatter.formatToParts(date)) {
		if (part.type === 'year') {
			year = part.value;
		} else if (part.type === 'month') {
			month = part.value;
		} else if (part.type === 'day') {
			day = part.value;
		}
	}
	if (year == null || month == null) {
		throw new Error('Date year/month parts not found');
	}
	return { year, month, day };
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

export type AgentLogUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens?: number;
	totalCost: number;
};

export type AgentPricingContext = {
	fetcher: LiteLLMPricingFetcher;
	dispose: () => void;
};

export function createAgentPricingContext(
	context: AdapterContext,
	createFetcher: () => LiteLLMPricingFetcher,
): AgentPricingContext {
	if (context.pricingFetcher != null) {
		return { fetcher: context.pricingFetcher, dispose: () => {} };
	}
	const fetcher = createFetcher();
	return { fetcher, dispose: () => fetcher[Symbol.dispose]() };
}

export type AgentLogLoaderConfig<Entry, Prepared = undefined> = {
	agent: AgentId;
	loadEntries: (options: AdapterOptions, context: AdapterContext) => Promise<Entry[]>;
	prepare?: (options: AdapterOptions, context: AdapterContext) => Promise<Prepared> | Prepared;
	disposePrepared?: (prepared: Prepared) => void;
	getTimestamp: (entry: Entry) => string;
	getSessionId: (entry: Entry) => string;
	getModels: (entry: Entry) => Iterable<string>;
	getUsage: (
		entry: Entry,
		prepared: Prepared,
		options: AdapterOptions,
		context: AdapterContext,
	) => AgentLogUsage | Promise<AgentLogUsage>;
	getMetadata?: (entries: Entry[], kind: ReportKind) => Record<string, unknown> | undefined;
};

export type AgentAdapterDefinition<TSource, TParsed, TRow = AgentUsageRow> = {
	agent: AgentId;
	detect: (options: AdapterOptions) => Promise<boolean>;
	discover: (options: AdapterOptions) => Promise<TSource[]>;
	parse: (
		source: TSource,
		options: AdapterOptions,
		context: AdapterContext,
	) => Promise<TParsed[]> | TParsed[];
	aggregate: (
		parsed: TParsed[],
		kind: ReportKind,
		options: AdapterOptions,
		context: AdapterContext,
	) => Promise<TRow[]> | TRow[];
};

export function defineAgentAdapter<TSource, TParsed, TRow = AgentUsageRow>(
	definition: AgentAdapterDefinition<TSource, TParsed, TRow>,
): AgentAdapterDefinition<TSource, TParsed, TRow> {
	return definition;
}

export function defineAgentLogLoader<Entry, Prepared = undefined>(
	config: AgentLogLoaderConfig<Entry, Prepared>,
): (
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
) => Promise<AgentUsageRow[]> {
	return async (kind, options, context) => {
		const since = normalizeDateFilter(options.since);
		const until = normalizeDateFilter(options.until);
		const entries = await config.loadEntries(options, context);
		const prepared = config.prepare == null ? undefined : await config.prepare(options, context);
		const groups = new Map<
			string,
			{
				row: AgentUsageRow;
				models: Set<string>;
				entries: Entry[];
			}
		>();

		try {
			for (const entry of entries) {
				const date = formatDateKey(config.getTimestamp(entry), options.timezone);
				if (!isWithinRange(date, since, until)) {
					continue;
				}

				const period =
					kind === 'session'
						? config.getSessionId(entry)
						: kind === 'monthly'
							? formatMonthKey(config.getTimestamp(entry), options.timezone)
							: date;
				const group = groups.get(period) ?? {
					row: createEmptyRow(period, config.agent),
					models: new Set(),
					entries: [],
				};
				if (!groups.has(period)) {
					groups.set(period, group);
				}

				const usage = await config.getUsage(entry, prepared as Prepared, options, context);
				group.row.inputTokens += usage.inputTokens;
				group.row.outputTokens += usage.outputTokens;
				group.row.cacheCreationTokens += usage.cacheCreationTokens;
				group.row.cacheReadTokens += usage.cacheReadTokens;
				group.row.totalTokens +=
					usage.totalTokens ??
					usage.inputTokens +
						usage.outputTokens +
						usage.cacheCreationTokens +
						usage.cacheReadTokens;
				group.row.totalCost += usage.totalCost;
				addModels(group.models, config.getModels(entry));
				group.entries.push(entry);
			}

			return Array.from(groups.values(), ({ row, models, entries }) => ({
				...row,
				modelsUsed: Array.from(models).sort(compareStrings),
				metadata: config.getMetadata?.(entries, kind),
			})).sort((a, b) => compareStrings(a.period, b.period));
		} finally {
			if (prepared !== undefined) {
				config.disposePrepared?.(prepared as Prepared);
			}
		}
	};
}

function addModels(target: Set<string>, models: Iterable<string>): void {
	for (const model of models) {
		target.add(model);
	}
}

if (import.meta.vitest != null) {
	describe('adapter date formatting', () => {
		beforeEach(() => {
			safeTimeZoneCache.clear();
			dateFormatterCache.clear();
			monthFormatterCache.clear();
			dateTimeFormatterCache.clear();
			dateKeyCache.clear();
			monthKeyCache.clear();
			defaultTimeZoneCache = undefined;
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		});

		it('rejects impossible calendar date filters', () => {
			expect(() => normalizeDateFilter('2026-02-31')).toThrow(
				'Invalid date: 2026-02-31. Use YYYY-MM-DD or YYYYMMDD.',
			);
			expect(() => normalizeDateFilter('20261340')).toThrow(
				'Invalid date: 20261340. Use YYYY-MM-DD or YYYYMMDD.',
			);
		});

		it('formats cached date and month keys', () => {
			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'UTC')).toBe('2026-05-16');
			expect(formatMonthKey('2026-05-16T12:34:56.000Z', 'UTC')).toBe('2026-05');
			expect(formatDateKey('2026-05-16T23:34:56.000Z', 'Asia/Tokyo')).toBe('2026-05-17');
		});

		it('uses ISO slices for UTC machine keys without date formatting', () => {
			safeTimeZone('UTC');
			class DateTimeFormatMock {
				constructor() {
					throw new Error('date formatter should not be created');
				}
			}
			vi.stubGlobal('Intl', {
				...Intl,
				DateTimeFormat: DateTimeFormatMock,
			});

			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'UTC')).toBe('2026-05-16');
			expect(formatMonthKey('2026-05-16T12:34:56.000Z', 'UTC')).toBe('2026-05');
		});

		it('uses local Date getters when timezone is omitted', () => {
			vi.stubEnv('TZ', 'Asia/Tokyo');
			const DateTimeFormat = Intl.DateTimeFormat;
			function DateTimeFormatMock(
				locale?: string | string[],
				options?: Intl.DateTimeFormatOptions,
			): Intl.DateTimeFormat {
				if (options?.timeZone != null) {
					throw new Error('date formatter should not be created');
				}
				return new DateTimeFormat(locale, options);
			}
			vi.stubGlobal('Intl', {
				...Intl,
				DateTimeFormat: DateTimeFormatMock,
			});

			expect(formatDateKey('2026-05-16T15:34:56.000Z')).toBe('2026-05-17');
			expect(formatMonthKey('2026-05-16T15:34:56.000Z')).toBe('2026-05');
		});

		it('uses locale formatting directly when it already produces machine date keys', () => {
			const DateTimeFormat = Intl.DateTimeFormat;
			const formatToParts = vi.fn((formatter: Intl.DateTimeFormat, date: Date) =>
				formatter.formatToParts(date),
			);
			function DateTimeFormatMock(
				locale?: string | string[],
				options?: Intl.DateTimeFormatOptions,
			): Intl.DateTimeFormat {
				const formatter = new DateTimeFormat(locale, options);
				return {
					format: (date: Date) => formatter.format(date),
					formatToParts: (date: Date) => formatToParts(formatter, date),
					resolvedOptions: () => formatter.resolvedOptions(),
				} as Intl.DateTimeFormat;
			}
			vi.stubGlobal('Intl', {
				...Intl,
				DateTimeFormat: DateTimeFormatMock,
			});

			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'Etc/GMT+11')).toBe('2026-05-16');
			expect(formatMonthKey('2026-05-16T12:34:56.000Z', 'Etc/GMT+11')).toBe('2026-05');
			expect(formatToParts).not.toHaveBeenCalled();
		});

		it('falls back to date parts when locale display text is not a machine date key', () => {
			const DateTimeFormat = Intl.DateTimeFormat;
			const formatToParts = vi.fn((formatter: Intl.DateTimeFormat, date: Date) =>
				formatter.formatToParts(date),
			);
			function DateTimeFormatMock(
				locale?: string | string[],
				options?: Intl.DateTimeFormatOptions,
			): Intl.DateTimeFormat {
				const formatter = new DateTimeFormat(locale, options);
				return {
					format: () => (options?.day == null ? '05/2026' : '05/16/2026'),
					formatToParts: (date: Date) => formatToParts(formatter, date),
					resolvedOptions: () => formatter.resolvedOptions(),
				} as Intl.DateTimeFormat;
			}
			vi.stubGlobal('Intl', {
				...Intl,
				DateTimeFormat: DateTimeFormatMock,
			});

			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'Etc/GMT+11')).toBe('2026-05-16');
			expect(formatMonthKey('2026-05-16T12:34:56.000Z', 'Etc/GMT+11')).toBe('2026-05');
			expect(formatToParts).toHaveBeenCalledTimes(2);
		});

		it('does not reuse one UTC hour cache entry across non-hour timezone date boundaries', () => {
			expect(formatDateKey('2026-05-31T18:10:00.000Z', 'Asia/Kathmandu')).toBe('2026-05-31');
			expect(formatDateKey('2026-05-31T18:20:00.000Z', 'Asia/Kathmandu')).toBe('2026-06-01');
			expect(formatMonthKey('2026-05-31T18:10:00.000Z', 'Asia/Kathmandu')).toBe('2026-05');
			expect(formatMonthKey('2026-05-31T18:20:00.000Z', 'Asia/Kathmandu')).toBe('2026-06');
		});

		it('falls back to UTC for invalid timezones', () => {
			expect(formatDateKey('2026-05-16T12:34:56.000Z', 'Invalid/Zone')).toBe('2026-05-16');
		});

		it('reuses the resolved local timezone when timezone is omitted', () => {
			const first = safeTimeZone();
			const second = safeTimeZone();

			expect(second).toBe(first);
		});
	});

	describe('defineAgentLogLoader', () => {
		it('does not dispose pricing fetchers owned by shared context', () => {
			const fetcher = new LiteLLMPricingFetcher({ offline: true });
			const dispose = vi.spyOn(fetcher, Symbol.dispose);
			const pricingContext = createAgentPricingContext({ pricingFetcher: fetcher }, () => {
				throw new Error('should not create an owned fetcher');
			});

			expect(pricingContext.fetcher).toBe(fetcher);
			pricingContext.dispose();
			expect(dispose).not.toHaveBeenCalled();
		});

		it('groups log entries into dated usage rows', async () => {
			const loadRows = defineAgentLogLoader({
				agent: 'amp',
				loadEntries: async () => [
					{
						timestamp: '2026-05-16T01:00:00.000Z',
						sessionId: 'thread-a',
						model: 'haiku-4-5',
						inputTokens: 10,
						outputTokens: 3,
						credits: 1.5,
					},
					{
						timestamp: '2026-05-16T02:00:00.000Z',
						sessionId: 'thread-a',
						model: 'opus-4-7',
						inputTokens: 4,
						outputTokens: 2,
						credits: 2,
					},
				],
				getTimestamp: (entry) => entry.timestamp,
				getSessionId: (entry) => entry.sessionId,
				getModels: (entry) => [entry.model],
				getUsage: (entry) => ({
					inputTokens: entry.inputTokens,
					outputTokens: entry.outputTokens,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				}),
				getMetadata: (entries) => ({
					credits: entries.reduce((total, entry) => total + entry.credits, 0),
				}),
			});

			await expect(loadRows('daily', { timezone: 'UTC' }, {})).resolves.toMatchObject([
				{
					period: '2026-05-16',
					agent: 'amp',
					modelsUsed: ['haiku-4-5', 'opus-4-7'],
					inputTokens: 14,
					outputTokens: 5,
					totalTokens: 19,
					metadata: { credits: 3.5 },
				},
			]);
		});

		it('uses session identifiers for session reports', async () => {
			const loadRows = defineAgentLogLoader({
				agent: 'pi',
				loadEntries: async () => [
					{
						timestamp: '2026-05-16T01:00:00.000Z',
						sessionId: 'session-a',
						model: '[pi] gpt-5.4',
						totalTokens: 7,
					},
				],
				getTimestamp: (entry) => entry.timestamp,
				getSessionId: (entry) => entry.sessionId,
				getModels: (entry) => [entry.model],
				getUsage: (entry) => ({
					inputTokens: 1,
					outputTokens: 2,
					cacheCreationTokens: 0,
					cacheReadTokens: 3,
					totalTokens: entry.totalTokens,
					totalCost: 0.01,
				}),
			});

			await expect(loadRows('session', { timezone: 'UTC' }, {})).resolves.toMatchObject([
				{
					period: 'session-a',
					agent: 'pi',
					modelsUsed: ['[pi] gpt-5.4'],
					totalTokens: 7,
					totalCost: 0.01,
				},
			]);
		});

		it('prepares shared aggregation state once and uses it after date filtering', async () => {
			const getUsage = vi.fn(
				async (
					entry: {
						timestamp: string;
						sessionId: string;
						model: string;
						inputTokens: number;
					},
					prepared: { multiplier: number },
				) => ({
					inputTokens: entry.inputTokens * prepared.multiplier,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				}),
			);
			const disposePrepared = vi.fn();
			const loadRows = defineAgentLogLoader({
				agent: 'amp',
				loadEntries: async () => [
					{
						timestamp: '2026-05-15T01:00:00.000Z',
						sessionId: 'outside',
						model: 'haiku-4-5',
						inputTokens: 100,
					},
					{
						timestamp: '2026-05-16T01:00:00.000Z',
						sessionId: 'inside',
						model: 'haiku-4-5',
						inputTokens: 10,
					},
				],
				prepare: async () => ({ multiplier: 2 }),
				disposePrepared,
				getTimestamp: (entry) => entry.timestamp,
				getSessionId: (entry) => entry.sessionId,
				getModels: (entry) => [entry.model],
				getUsage,
			});

			await expect(
				loadRows('daily', { since: '20260516', until: '20260516', timezone: 'UTC' }, {}),
			).resolves.toMatchObject([
				{
					period: '2026-05-16',
					inputTokens: 20,
					totalTokens: 20,
				},
			]);
			expect(getUsage).toHaveBeenCalledTimes(1);
			expect(disposePrepared).toHaveBeenCalledWith({ multiplier: 2 });
		});
	});
}
