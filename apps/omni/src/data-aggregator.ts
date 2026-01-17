import type {
	CombinedTotals,
	Source,
	SourceTotals,
	UnifiedDailyUsage,
	UnifiedMonthlyUsage,
	UnifiedSessionUsage,
} from './_types.ts';
import { buildDailyReport as buildCodexDailyReport } from '@ccusage/codex/daily-report';
import { loadTokenUsageEvents } from '@ccusage/codex/data-loader';
import { buildMonthlyReport as buildCodexMonthlyReport } from '@ccusage/codex/monthly-report';
import { CodexPricingSource } from '@ccusage/codex/pricing';
import { buildSessionReport as buildCodexSessionReport } from '@ccusage/codex/session-report';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { buildDailyReport as buildOpenCodeDailyReport } from '@ccusage/opencode/daily-report';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '@ccusage/opencode/data-loader';
import { buildMonthlyReport as buildOpenCodeMonthlyReport } from '@ccusage/opencode/monthly-report';
import { buildSessionReport as buildOpenCodeSessionReport } from '@ccusage/opencode/session-report';
import {
	loadPiAgentDailyData,
	loadPiAgentMonthlyData,
	loadPiAgentSessionData,
} from '@ccusage/pi/data-loader';
import { loadDailyUsageData, loadMonthlyUsageData, loadSessionData } from 'ccusage/data-loader';
import { SOURCE_ORDER } from './_consts.ts';
import {
	normalizeClaudeDaily,
	normalizeClaudeMonthly,
	normalizeClaudeSession,
	normalizeCodexDaily,
	normalizeCodexMonthly,
	normalizeCodexSession,
	normalizeOpenCodeDaily,
	normalizeOpenCodeMonthly,
	normalizeOpenCodeSession,
	normalizePiDaily,
	normalizePiMonthly,
	normalizePiSession,
} from './_normalizers/index.ts';
import { Sources } from './_types.ts';
import { logger } from './logger.ts';

export type CombinedLoadOptions = {
	sources?: Source[];
	since?: string; // YYYY-MM-DD
	until?: string; // YYYY-MM-DD
	timezone?: string;
	locale?: string;
	offline?: boolean;
};

export type CombinedResult<T> = {
	data: T[];
	totals: CombinedTotals | null;
};

function calculateTotals<
	T extends { source: Source; costUSD: number } & {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		totalTokens: number;
	},
>(entries: T[]): CombinedTotals | null {
	if (entries.length === 0) {
		return null;
	}

	const bySourceMap = new Map<Source, SourceTotals>();

	for (const entry of entries) {
		const existing = bySourceMap.get(entry.source) ?? {
			source: entry.source,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			totalTokens: 0,
			costUSD: 0,
		};

		existing.inputTokens += entry.inputTokens;
		existing.outputTokens += entry.outputTokens;
		existing.cacheReadTokens += entry.cacheReadTokens;
		existing.cacheCreationTokens += entry.cacheCreationTokens;
		existing.totalTokens += entry.totalTokens;
		existing.costUSD += entry.costUSD;

		bySourceMap.set(entry.source, existing);
	}

	const bySource = SOURCE_ORDER.filter((source) => bySourceMap.has(source)).map(
		(source) => bySourceMap.get(source)!,
	);

	const costUSD = bySource.reduce((sum, source) => sum + source.costUSD, 0);

	return {
		costUSD,
		bySource,
	};
}

function isSourceEnabled(source: Source, selected?: Source[]): boolean {
	if (selected == null || selected.length === 0) {
		return true;
	}
	return selected.includes(source);
}

function toCompactDate(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}
	return value.replace(/-/g, '');
}

export async function loadCombinedDailyData(
	options: CombinedLoadOptions = {},
): Promise<CombinedResult<UnifiedDailyUsage>> {
	const results: UnifiedDailyUsage[] = [];
	const selectedSources = options.sources;
	const claudeSince = toCompactDate(options.since);
	const claudeUntil = toCompactDate(options.until);

	if (isSourceEnabled('claude', selectedSources)) {
		try {
			const dailyData = await loadDailyUsageData({
				since: claudeSince,
				until: claudeUntil,
				timezone: options.timezone,
				locale: options.locale,
				order: 'asc',
				offline: options.offline,
			});

			for (const entry of dailyData) {
				results.push(normalizeClaudeDaily(entry));
			}
		} catch (error) {
			logger.warn('Failed to load Claude daily usage data.', error);
		}
	}

	if (isSourceEnabled('codex', selectedSources)) {
		try {
			const { events, missingDirectories } = await loadTokenUsageEvents({
				since: options.since,
				until: options.until,
			});
			for (const missing of missingDirectories) {
				logger.debug(`Codex session directory not found: ${missing}`);
			}

			if (events.length > 0) {
				const pricingSource = new CodexPricingSource({ offline: options.offline });
				try {
					const rows = await buildCodexDailyReport(events, {
						pricingSource,
						timezone: options.timezone,
						locale: options.locale,
						since: options.since,
						until: options.until,
						formatDate: false,
					});

					for (const row of rows) {
						results.push(normalizeCodexDaily(row));
					}
				} finally {
					pricingSource[Symbol.dispose]();
				}
			}
		} catch (error) {
			logger.warn('Failed to load Codex daily usage data.', error);
		}
	}

	if (isSourceEnabled('opencode', selectedSources)) {
		try {
			const entries = await loadOpenCodeMessages({
				since: options.since,
				until: options.until,
			});
			if (entries.length > 0) {
				using fetcher = new LiteLLMPricingFetcher({ offline: options.offline, logger });
				const rows = await buildOpenCodeDailyReport(entries, { pricingFetcher: fetcher });
				for (const row of rows) {
					results.push(normalizeOpenCodeDaily(row));
				}
			}
		} catch (error) {
			logger.warn('Failed to load OpenCode daily usage data.', error);
		}
	}

	if (isSourceEnabled('pi', selectedSources)) {
		try {
			const piData = await loadPiAgentDailyData({
				since: options.since,
				until: options.until,
				timezone: options.timezone,
				order: 'asc',
			});

			for (const entry of piData) {
				results.push(normalizePiDaily(entry));
			}
		} catch (error) {
			logger.warn('Failed to load Pi daily usage data.', error);
		}
	}

	results.sort((a, b) => {
		const dateCompare = a.date.localeCompare(b.date);
		if (dateCompare !== 0) {
			return dateCompare;
		}
		return SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
	});

	return {
		data: results,
		totals: calculateTotals(results),
	};
}

export async function loadCombinedMonthlyData(
	options: CombinedLoadOptions = {},
): Promise<CombinedResult<UnifiedMonthlyUsage>> {
	const results: UnifiedMonthlyUsage[] = [];
	const selectedSources = options.sources;
	const claudeSince = toCompactDate(options.since);
	const claudeUntil = toCompactDate(options.until);

	if (isSourceEnabled('claude', selectedSources)) {
		try {
			const monthlyData = await loadMonthlyUsageData({
				since: claudeSince,
				until: claudeUntil,
				timezone: options.timezone,
				locale: options.locale,
				order: 'asc',
				offline: options.offline,
			});

			for (const entry of monthlyData) {
				results.push(normalizeClaudeMonthly(entry));
			}
		} catch (error) {
			logger.warn('Failed to load Claude monthly usage data.', error);
		}
	}

	if (isSourceEnabled('codex', selectedSources)) {
		try {
			const { events, missingDirectories } = await loadTokenUsageEvents({
				since: options.since,
				until: options.until,
			});
			for (const missing of missingDirectories) {
				logger.debug(`Codex session directory not found: ${missing}`);
			}

			if (events.length > 0) {
				const pricingSource = new CodexPricingSource({ offline: options.offline });
				try {
					const rows = await buildCodexMonthlyReport(events, {
						pricingSource,
						timezone: options.timezone,
						locale: options.locale,
						since: options.since,
						until: options.until,
						formatDate: false,
					});

					for (const row of rows) {
						results.push(normalizeCodexMonthly(row));
					}
				} finally {
					pricingSource[Symbol.dispose]();
				}
			}
		} catch (error) {
			logger.warn('Failed to load Codex monthly usage data.', error);
		}
	}

	if (isSourceEnabled('opencode', selectedSources)) {
		try {
			const entries = await loadOpenCodeMessages({
				since: options.since,
				until: options.until,
			});
			if (entries.length > 0) {
				using fetcher = new LiteLLMPricingFetcher({ offline: options.offline, logger });
				const rows = await buildOpenCodeMonthlyReport(entries, { pricingFetcher: fetcher });
				for (const row of rows) {
					results.push(normalizeOpenCodeMonthly(row));
				}
			}
		} catch (error) {
			logger.warn('Failed to load OpenCode monthly usage data.', error);
		}
	}

	if (isSourceEnabled('pi', selectedSources)) {
		try {
			const piData = await loadPiAgentMonthlyData({
				since: options.since,
				until: options.until,
				timezone: options.timezone,
				order: 'asc',
			});

			for (const entry of piData) {
				results.push(normalizePiMonthly(entry));
			}
		} catch (error) {
			logger.warn('Failed to load Pi monthly usage data.', error);
		}
	}

	results.sort((a, b) => {
		const monthCompare = a.month.localeCompare(b.month);
		if (monthCompare !== 0) {
			return monthCompare;
		}
		return SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
	});

	return {
		data: results,
		totals: calculateTotals(results),
	};
}

export async function loadCombinedSessionData(
	options: CombinedLoadOptions = {},
): Promise<CombinedResult<UnifiedSessionUsage>> {
	const results: UnifiedSessionUsage[] = [];
	const selectedSources = options.sources;
	const claudeSince = toCompactDate(options.since);
	const claudeUntil = toCompactDate(options.until);

	if (isSourceEnabled('claude', selectedSources)) {
		try {
			const sessionData = await loadSessionData({
				since: claudeSince,
				until: claudeUntil,
				timezone: options.timezone,
				locale: options.locale,
				order: 'asc',
				offline: options.offline,
			});

			for (const entry of sessionData) {
				results.push(normalizeClaudeSession(entry));
			}
		} catch (error) {
			logger.warn('Failed to load Claude session usage data.', error);
		}
	}

	if (isSourceEnabled('codex', selectedSources)) {
		try {
			const { events, missingDirectories } = await loadTokenUsageEvents({
				since: options.since,
				until: options.until,
			});
			for (const missing of missingDirectories) {
				logger.debug(`Codex session directory not found: ${missing}`);
			}

			if (events.length > 0) {
				const pricingSource = new CodexPricingSource({ offline: options.offline });
				try {
					const rows = await buildCodexSessionReport(events, {
						pricingSource,
						timezone: options.timezone,
						locale: options.locale,
						since: options.since,
						until: options.until,
					});

					for (const row of rows) {
						results.push(normalizeCodexSession(row));
					}
				} finally {
					pricingSource[Symbol.dispose]();
				}
			}
		} catch (error) {
			logger.warn('Failed to load Codex session usage data.', error);
		}
	}

	if (isSourceEnabled('opencode', selectedSources)) {
		try {
			const [entries, sessionMetadata] = await Promise.all([
				loadOpenCodeMessages({
					since: options.since,
					until: options.until,
				}),
				loadOpenCodeSessions(),
			]);

			if (entries.length > 0) {
				using fetcher = new LiteLLMPricingFetcher({ offline: options.offline, logger });
				const rows = await buildOpenCodeSessionReport(entries, {
					pricingFetcher: fetcher,
					sessionMetadata,
				});
				for (const row of rows) {
					results.push(normalizeOpenCodeSession(row));
				}
			}
		} catch (error) {
			logger.warn('Failed to load OpenCode session usage data.', error);
		}
	}

	if (isSourceEnabled('pi', selectedSources)) {
		try {
			const piData = await loadPiAgentSessionData({
				since: options.since,
				until: options.until,
				timezone: options.timezone,
				order: 'asc',
			});

			for (const entry of piData) {
				results.push(normalizePiSession(entry));
			}
		} catch (error) {
			logger.warn('Failed to load Pi session usage data.', error);
		}
	}

	results.sort((a, b) => {
		const timeCompare = a.lastTimestamp.localeCompare(b.lastTimestamp);
		if (timeCompare !== 0) {
			return timeCompare;
		}
		return SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
	});

	return {
		data: results,
		totals: calculateTotals(results),
	};
}

export function parseSources(value?: string): Source[] {
	if (value == null || value.trim() === '') {
		return [...Sources];
	}

	const normalized = value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '');

	const seen = new Set<Source>();
	const sources: Source[] = [];
	const invalid: string[] = [];

	for (const item of normalized) {
		if (!(Sources as readonly string[]).includes(item)) {
			invalid.push(item);
			continue;
		}

		const source = item as Source;
		if (!seen.has(source)) {
			seen.add(source);
			sources.push(source);
		}
	}

	if (invalid.length > 0) {
		throw new Error(`Unknown sources: ${invalid.join(', ')}`);
	}

	return sources;
}

export function normalizeDateInput(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}

	const compact = value.replace(/-/g, '').trim();
	if (!/^\d{8}$/.test(compact)) {
		throw new Error(`Invalid date format: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`);
	}

	return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export function resolveDateRangeFromDays(
	days?: number,
	timezone?: string,
): { since?: string; until?: string } {
	if (days == null) {
		return {};
	}

	if (!Number.isFinite(days) || days <= 0) {
		throw new Error('Days must be a positive number.');
	}

	const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: tz,
	});

	const now = new Date();
	const until = formatter.format(now);
	const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
	const since = formatter.format(start);

	return { since, until };
}

if (import.meta.vitest != null) {
	describe('calculateTotals', () => {
		it('aggregates per-source totals and overall cost', () => {
			const totals = calculateTotals([
				{
					source: 'claude',
					date: '2025-01-01',
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheCreationTokens: 1,
					totalTokens: 18,
					costUSD: 1,
					models: [],
				},
				{
					source: 'codex',
					date: '2025-01-02',
					inputTokens: 20,
					outputTokens: 10,
					cacheReadTokens: 5,
					cacheCreationTokens: 0,
					totalTokens: 30,
					costUSD: 2,
					models: [],
				},
			]);

			expect(totals?.costUSD).toBe(3);
			expect(totals?.bySource).toHaveLength(2);
			expect(totals?.bySource[0]?.source).toBe('claude');
		});
	});

	describe('parseSources', () => {
		it('parses a comma-separated list of sources', () => {
			const sources = parseSources('claude,codex');
			expect(sources).toEqual(['claude', 'codex']);
		});

		it('throws on unknown sources', () => {
			expect(() => parseSources('claude,unknown')).toThrow('Unknown sources');
		});
	});

	describe('normalizeDateInput', () => {
		it('normalizes compact date to YYYY-MM-DD', () => {
			expect(normalizeDateInput('20250105')).toBe('2025-01-05');
		});

		it('keeps dashed date format', () => {
			expect(normalizeDateInput('2025-01-05')).toBe('2025-01-05');
		});
	});
}
