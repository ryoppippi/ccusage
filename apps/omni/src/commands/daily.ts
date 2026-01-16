import process from 'node:process';
import {
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { CODEX_CACHE_NOTE } from '../_consts.ts';
import {
	loadCombinedDailyData,
	normalizeDateInput,
	parseSources,
	resolveDateRangeFromDays,
} from '../data-aggregator.ts';
import { log, logger } from '../logger.ts';
import {
	formatCacheValue,
	formatCostSummary,
	formatSourceLabel,
	formatSourcesTitle,
} from './_shared.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show combined usage report grouped by day',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
			default: false,
		},
		sources: {
			type: 'string',
			short: 's',
			description: 'Comma-separated list of sources to include',
		},
		compact: {
			type: 'boolean',
			short: 'c',
			description: 'Force compact table mode',
			default: false,
		},
		since: {
			type: 'string',
			description: 'Start date (YYYY-MM-DD or YYYYMMDD)',
		},
		until: {
			type: 'string',
			description: 'End date (YYYY-MM-DD or YYYYMMDD)',
		},
		days: {
			type: 'number',
			short: 'd',
			description: 'Show last N days',
		},
		timezone: {
			type: 'string',
			description: 'Timezone for date grouping',
		},
		locale: {
			type: 'string',
			description: 'Locale for formatting',
		},
		offline: {
			type: 'boolean',
			negatable: true,
			description: 'Use cached pricing data',
			default: false,
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let sources;
		let since: string | undefined;
		let until: string | undefined;

		try {
			sources = parseSources(ctx.values.sources);
			since = normalizeDateInput(ctx.values.since);
			until = normalizeDateInput(ctx.values.until);

			if (ctx.values.days != null) {
				const range = resolveDateRangeFromDays(ctx.values.days, ctx.values.timezone);
				since = range.since;
				until = range.until;
			}
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const { data, totals } = await loadCombinedDailyData({
			sources,
			since,
			until,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
			offline: ctx.values.offline,
		});

		if (data.length === 0) {
			log(jsonOutput ? JSON.stringify({ daily: [], totals: null }) : 'No usage data found.');
			return;
		}

		if (jsonOutput) {
			log(
				JSON.stringify(
					{
						daily: data,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		logger.box(`Omni Usage Report - Daily (${formatSourcesTitle(sources)})`);

		const table: ResponsiveTable = new ResponsiveTable({
			head: ['Source', 'Date', 'Input', 'Output', 'Cache', 'Cost (USD)', 'Models'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'left'],
			compactHead: ['Source', 'Date', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: ctx.values.compact,
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) =>
				formatDateCompact(dateStr, ctx.values.timezone, ctx.values.locale),
		});

		let hasCodex = false;
		for (const row of data) {
			const cacheTokens = row.cacheReadTokens + row.cacheCreationTokens;
			if (row.source === 'codex') {
				hasCodex = true;
			}

			table.push([
				formatSourceLabel(row.source),
				row.date,
				formatNumber(row.inputTokens),
				formatNumber(row.outputTokens),
				formatCacheValue(row.source, cacheTokens),
				formatCurrency(row.costUSD),
				formatModelsDisplayMultiline(row.models),
			]);
		}

		log(table.toString());

		if (hasCodex) {
			log(`\n${CODEX_CACHE_NOTE}`);
		}

		if (totals != null) {
			log(`\n${formatCostSummary(totals)}`);
		}

		if (table.isCompactMode()) {
			log('\nRunning in Compact Mode');
			log('Expand terminal width to see cache metrics and models');
		}
	},
});
