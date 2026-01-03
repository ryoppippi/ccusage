import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { DEFAULT_TIMEZONE } from '../_consts.ts';
import { sharedArgs } from '../_shared-args.ts';
import { formatModelsList } from '../command-utils.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { OpenCodePricingSource } from '../pricing.ts';
import { buildSessionReport } from '../session-report.ts';

const TABLE_COLUMN_COUNT = 11;

export const sessionCommand = define({
	name: 'session',
	description: 'Show OpenCode token usage grouped by session',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let since: string | undefined;
		let until: string | undefined;

		try {
			since = normalizeFilterDate(ctx.values.since);
			until = normalizeFilterDate(ctx.values.until);
		}
		catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const { events, missingDirectory } = await loadTokenUsageEvents();

		if (missingDirectory) {
			logger.warn('OpenCode data directory not found');
		}

		if (events.length === 0) {
			log(jsonOutput ? JSON.stringify({ sessions: [], totals: null }) : 'No OpenCode usage data found.');
			return;
		}

		const pricingSource = new OpenCodePricingSource({
			offline: ctx.values.offline,
		});

		try {
			const rows = await buildSessionReport(events, {
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
				pricingSource,
			});

			if (rows.length === 0) {
				log(jsonOutput ? JSON.stringify({ sessions: [], totals: null }) : 'No OpenCode usage data found for provided filters.');
				return;
			}

			const totals = rows.reduce((acc, row) => {
				acc.inputTokens += row.inputTokens;
				acc.outputTokens += row.outputTokens;
				acc.reasoningTokens += row.reasoningTokens;
				acc.cacheReadTokens += row.cacheReadTokens;
				acc.cacheWriteTokens += row.cacheWriteTokens;
				acc.totalTokens += row.totalTokens;
				acc.costUSD += row.costUSD;
				return acc;
			}, {
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUSD: 0,
			});

			if (jsonOutput) {
				log(JSON.stringify({ sessions: rows, totals }, null, 2));
				return;
			}

			logger.box(`OpenCode Token Usage Report - Sessions (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`);

			const table: ResponsiveTable = new ResponsiveTable({
				head: ['Session', 'Project', 'Models', 'Input', 'Output', 'Reasoning', 'Cache Read', 'Cache Write', 'Total Tokens', 'Cost (USD)', 'Last Activity'],
				colAligns: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
				compactHead: ['Session', 'Project', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
			});

			for (const row of rows) {
				const shortSession = row.sessionId.length > 12 ? `…${row.sessionId.slice(-12)}` : row.sessionId;
				const shortProject = row.projectId.length > 12 ? `…${row.projectId.slice(-12)}` : row.projectId;

				table.push([
					shortSession,
					shortProject,
					formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(row.inputTokens),
					formatNumber(row.outputTokens),
					formatNumber(row.reasoningTokens),
					formatNumber(row.cacheReadTokens),
					formatNumber(row.cacheWriteTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
					row.lastActivity,
				]);
			}

			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				pc.yellow('Total'),
				'',
				'',
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.reasoningTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(totals.cacheWriteTokens)),
				pc.yellow(formatNumber(totals.totalTokens)),
				pc.yellow(formatCurrency(totals.costUSD)),
				'',
			]);

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see models, cache metrics, total tokens, and last activity');
			}
		}
		finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
