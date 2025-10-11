import type { CodexSessionBlock } from '../_session-blocks.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { convertEventsToBlockEntries } from '../_block-entry.ts';
import { processWithJq } from '../_jq-processor.ts';
import { DEFAULT_SESSION_DURATION_HOURS, filterRecentBlocks, identifyCodexSessionBlocks } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { buildCodexBlocksReport } from '../block-calculator.ts';
import { formatModelsList, splitUsageTokens } from '../command-utils.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { isWithinRange, normalizeFilterDate } from '../date-utils.ts';
import { startCodexLiveMonitor } from '../live-monitor.ts';
import { log, logger } from '../logger.ts';

import { CodexPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

export const blocksCommand = define({
	name: 'blocks',
	description: 'Show Codex usage grouped by billing blocks',
	args: {
		...sharedArgs,
		jq: {
			type: 'string',
			description: 'Process JSON output with jq',
		},
		active: {
			type: 'boolean',
			description: 'Show only active block',
			default: false,
		},
		recent: {
			type: 'boolean',
			description: 'Show blocks from the last 3 days (including active)',
			default: false,
		},
		tokenLimit: {
			type: 'string',
			description: 'Token limit for usage warnings (number or "max")',
		},
		sessionLength: {
			type: 'number',
			description: 'Session block duration in hours',
			default: DEFAULT_SESSION_DURATION_HOURS,
		},
		order: {
			type: 'string',
			description: 'Sort order for blocks (asc or desc)',
			default: 'asc',
		},
		live: {
			type: 'boolean',
			description: 'Live monitoring mode',
			default: false,
		},
		refreshInterval: {
			type: 'number',
			description: 'Refresh interval for live mode in seconds',
			default: 5,
		},
	},
	toKebab: true,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json || ctx.values.jq);
		if (jsonOutput) {
			logger.level = 0;
		}

		if (ctx.values.sessionLength <= 0) {
			logger.error('Session length must be a positive number');
			process.exit(1);
		}

		const order = ctx.values.order === 'desc' ? 'desc' : 'asc';

		if (ctx.values.live) {
			const refreshSeconds = Number.isFinite(ctx.values.refreshInterval)
				? Math.min(Math.max(ctx.values.refreshInterval, 1), 60)
				: 5;
			const controller = new AbortController();
			const handleAbort = () => controller.abort();
			process.once('SIGINT', handleAbort);
			try {
				await startCodexLiveMonitor({
					codexPaths: [],
					sessionDurationHours: ctx.values.sessionLength,
					refreshIntervalMs: refreshSeconds * 1_000,
					tokenLimit: parseTokenLimit(ctx.values.tokenLimit, 0),
					offline: ctx.values.offline,
				}, controller.signal);
			}
			finally {
				process.removeListener('SIGINT', handleAbort);
			}
			return;
		}

		let since: string | undefined;
		let until: string | undefined;
		try {
			if (ctx.values.since != null) {
				since = normalizeFilterDate(ctx.values.since);
			}
			if (ctx.values.until != null) {
				until = normalizeFilterDate(ctx.values.until);
			}
		}
		catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const sessionDurationHours = ctx.values.sessionLength ?? DEFAULT_SESSION_DURATION_HOURS;
		const { events, missingDirectories } = await loadTokenUsageEvents();

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			const emptyJson = { blocks: [], totals: null, metadata: { missingDirectories } };
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(emptyJson, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
				return;
			}
			if (jsonOutput) {
				log(JSON.stringify(emptyJson, null, 2));
			}
			else {
				logger.warn('No Codex usage data found.');
			}
			return;
		}

		const entries = convertEventsToBlockEntries(events);
		let blocks = identifyCodexSessionBlocks(entries, sessionDurationHours);

		blocks = blocks.filter((block) => {
			const dateKey = block.startTime.toISOString().slice(0, 10);
			return isWithinRange(dateKey, since, until);
		});

		let maxTokensFromAll = 0;
		for (const block of blocks) {
			if (block.isGap === true || block.isActive) {
				continue;
			}
			if (block.tokenCounts.totalTokens > maxTokensFromAll) {
				maxTokensFromAll = block.tokenCounts.totalTokens;
			}
		}

		if (ctx.values.recent) {
			blocks = filterRecentBlocks(blocks);
		}

		if (ctx.values.active) {
			blocks = blocks.filter(block => block.isActive);
		}

		blocks.sort((a, b) => {
			const diff = a.startTime.getTime() - b.startTime.getTime();
			return order === 'asc' ? diff : -diff;
		});

		if (blocks.length === 0) {
			const emptyJson = { blocks: [], totals: null, metadata: { missingDirectories } };
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(emptyJson, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
				return;
			}
			if (jsonOutput) {
				log(JSON.stringify(emptyJson, null, 2));
			}
			else {
				logger.warn('No Codex usage data found for provided filters.');
			}
			return;
		}

		const tokenLimit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);

		using pricingSource = new CodexPricingSource({ offline: ctx.values.offline });
		const report = await buildCodexBlocksReport({
			blocks,
			pricingSource,
			tokenLimit,
		});

		const jsonPayload = {
			blocks: report.blocks.map(summary => ({
				id: summary.block.id,
				startTime: summary.block.startTime.toISOString(),
				endTime: summary.block.endTime.toISOString(),
				actualEndTime: summary.block.actualEndTime?.toISOString() ?? null,
				isActive: summary.block.isActive,
				isGap: summary.block.isGap ?? false,
				tokenCounts: summary.block.tokenCounts,
				costUSD: summary.block.costUSD,
				models: summary.models,
				burnRate: summary.burnRate,
				projection: summary.projection,
				tokenLimitStatus: summary.tokenLimitStatus,
				usagePercent: summary.usagePercent,
			})),
			totals: {
				tokenCounts: report.totals.tokenCounts,
				costUSD: report.totals.costUSD,
			},
			metadata: {
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				order,
				generatedAt: new Date().toISOString(),
				missingDirectories,
			},
		};

		if (ctx.values.jq != null) {
			const jqResult = await processWithJq(jsonPayload, ctx.values.jq);
			if (Result.isFailure(jqResult)) {
				logger.error(jqResult.error.message);
				process.exit(1);
			}
			log(jqResult.value);
			return;
		}

		if (jsonOutput) {
			log(JSON.stringify(jsonPayload, null, 2));
			return;
		}

		logger.box(`Codex Blocks Report (Timezone: ${ctx.values.timezone})`);

		const table = new ResponsiveTable({
			head: ['Window', 'Models', 'Input', 'Output', 'Cache', 'Total Tokens', 'Cost (USD)', 'Status'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
			compactHead: ['Window', 'Models', 'Tokens', 'Cost', 'Status'],
			compactColAligns: ['left', 'left', 'right', 'right', 'left'],
			compactThreshold: 100,
			forceCompact: ctx.values.compact,
			style: { head: ['cyan'] },
		});

		const totalsForDisplay = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			costUSD: 0,
		};

		for (const summary of report.blocks) {
			const split = splitUsageTokens(summary.block.tokenCounts);
			totalsForDisplay.inputTokens += split.inputTokens;
			totalsForDisplay.outputTokens += split.outputTokens;
			totalsForDisplay.cacheReadTokens += split.cacheReadTokens;
			totalsForDisplay.reasoningTokens += split.reasoningTokens;
			totalsForDisplay.totalTokens += summary.block.tokenCounts.totalTokens;
			totalsForDisplay.costUSD += summary.block.costUSD;

			if (summary.block.isGap === true) {
				table.push([
					pc.gray(formatBlockTime(summary.block, table.isCompactMode(), ctx.values.locale)),
					pc.gray('-'),
					pc.gray('-'),
					pc.gray('-'),
					pc.gray('-'),
					pc.gray('-'),
					pc.gray('-'),
					pc.gray('GAP'),
				]);
				continue;
			}

			const modelMap = Object.fromEntries(Object.entries(summary.models).map(([model, usage]) => [
				model,
				{ totalTokens: usage.totalTokens, isFallback: usage.isFallback },
			]));

			const statusParts: string[] = [];
			if (summary.block.isActive) {
				statusParts.push(pc.cyan('ACTIVE'));
			}
			if (summary.tokenLimitStatus === 'warning') {
				const percent = summary.usagePercent != null ? Math.round(summary.usagePercent * 100) : undefined;
				statusParts.push(pc.yellow(percent != null ? `⚠️ ${percent}%` : '⚠️ WARNING'));
			}
			if (summary.tokenLimitStatus === 'exceeds') {
				const percent = summary.usagePercent != null ? Math.round(summary.usagePercent * 100) : undefined;
				statusParts.push(pc.red(percent != null ? `🔥 ${percent}%` : '🔥 EXCEEDS'));
			}

			table.push([
				formatBlockTime(summary.block, table.isCompactMode(), ctx.values.locale),
				formatModelsDisplayMultiline(formatModelsList(modelMap)),
				formatNumber(split.inputTokens),
				formatNumber(split.outputTokens),
				formatNumber(split.cacheReadTokens),
				formatNumber(summary.block.tokenCounts.totalTokens),
				formatCurrency(summary.block.costUSD),
				statusParts.join(' '),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totalsForDisplay.inputTokens)),
			pc.yellow(formatNumber(totalsForDisplay.outputTokens)),
			pc.yellow(formatNumber(totalsForDisplay.cacheReadTokens)),
			pc.yellow(formatNumber(totalsForDisplay.totalTokens)),
			pc.yellow(formatCurrency(totalsForDisplay.costUSD)),
			'',
		]);

		log(table.toString());

		if (table.isCompactMode()) {
			logger.info('\nRunning in Compact Mode');
			logger.info('Expand terminal width to see cache metrics and totals');
		}
	},
});

export function formatBlockTime(block: CodexSessionBlock, compact = false, locale?: string): string {
	const formatterOptions: Intl.DateTimeFormatOptions = compact
		? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
		: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };

	const formatDate = (date: Date): string => date.toLocaleString(locale, formatterOptions);

	if (block.isGap === true) {
		const start = formatDate(block.startTime);
		const end = formatDate(block.endTime);
		const durationHours = Math.round((block.endTime.getTime() - block.startTime.getTime()) / (1000 * 60 * 60));
		return compact
			? `${start}\n${end}\n(${durationHours}h gap)`
			: `${start} - ${end} (${durationHours}h gap)`;
	}

	const start = formatDate(block.startTime);

	if (block.isActive) {
		const now = new Date();
		const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - block.startTime.getTime()) / (1000 * 60)));
		const remainingMinutes = Math.max(0, Math.floor((block.endTime.getTime() - now.getTime()) / (1000 * 60)));
		const elapsedHours = Math.floor(elapsedMinutes / 60);
		const elapsedMins = elapsedMinutes % 60;
		const remainingHours = Math.floor(remainingMinutes / 60);
		const remainingMins = remainingMinutes % 60;
		if (compact) {
			return `${start}\n(${elapsedHours}h${elapsedMins}m/${remainingHours}h${remainingMins}m)`;
		}
		return `${start} (${elapsedHours}h ${elapsedMins}m elapsed, ${remainingHours}h ${remainingMins}m remaining)`;
	}

	const actualEnd = block.actualEndTime ?? block.endTime;
	const durationMinutes = Math.max(0, Math.floor((actualEnd.getTime() - block.startTime.getTime()) / (1000 * 60)));
	const durationHours = Math.floor(durationMinutes / 60);
	const remainingMins = durationMinutes % 60;
	if (compact) {
		return `${start}\n(${durationHours}h${remainingMins}m)`;
	}
	if (durationHours > 0) {
		return `${start} (${durationHours}h ${remainingMins}m)`;
	}
	return `${start} (${remainingMins}m)`;
}

export function parseTokenLimit(value: string | undefined, maxFromAll: number): number | undefined {
	if (value == null || value.trim() === '') {
		return undefined;
	}

	const trimmed = value.trim().toLowerCase();
	if (trimmed === 'max') {
		return maxFromAll > 0 ? maxFromAll : undefined;
	}

	const limit = Number.parseInt(trimmed, 10);
	return Number.isNaN(limit) ? undefined : limit;
}

if (import.meta.vitest != null) {
	function createBlock(overrides: Partial<CodexSessionBlock> = {}): CodexSessionBlock {
		const startTime = overrides.startTime ?? new Date('2025-10-05T00:00:00.000Z');
		return {
			id: startTime.toISOString(),
			startTime,
			endTime: overrides.endTime ?? new Date(startTime.getTime() + DEFAULT_SESSION_DURATION_HOURS * 60 * 60 * 1000),
			actualEndTime: overrides.actualEndTime,
			isActive: overrides.isActive ?? false,
			isGap: overrides.isGap,
			entries: overrides.entries ?? [],
			tokenCounts: overrides.tokenCounts ?? {
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
			},
			costUSD: overrides.costUSD ?? 0,
			models: overrides.models ?? [],
		};
	}

	describe('formatBlockTime', () => {
		it('renders elapsed and remaining time for active blocks', () => {
			const now = new Date();
			const start = new Date(now.getTime() - 60 * 60 * 1000);
			const block = createBlock({
				startTime: start,
				endTime: new Date(start.getTime() + DEFAULT_SESSION_DURATION_HOURS * 60 * 60 * 1000),
				actualEndTime: new Date(now.getTime() - 5 * 60 * 1000),
				isActive: true,
			});
			const formatted = formatBlockTime(block, true, 'en-US');
			expect(formatted).toContain('h');
			expect(formatted).toContain('m');
		});

		it('renders gap block start and end as a range', () => {
			const block = createBlock({
				isGap: true,
				startTime: new Date('2025-10-05T05:00:00.000Z'),
				endTime: new Date('2025-10-05T07:30:00.000Z'),
			});
			const formatted = formatBlockTime(block, false, 'en-US');
			expect(formatted).toContain('2025');
			expect(formatted).toContain('gap');
		});
	});

	describe('parseTokenLimit', () => {
		it('parses numeric string token limits', () => {
			expect(parseTokenLimit('5000', 0)).toBe(5000);
		});

		it('returns the maximum token count when value is max', () => {
			expect(parseTokenLimit('max', 1200)).toBe(1200);
		});

		it('returns undefined for invalid input', () => {
			expect(parseTokenLimit('invalid', 100)).toBeUndefined();
			expect(parseTokenLimit(undefined, 100)).toBeUndefined();
		});
	});
}
