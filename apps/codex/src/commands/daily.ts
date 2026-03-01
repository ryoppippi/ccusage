import type { TableCellAlign } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { DEFAULT_TIMEZONE } from '../_consts.ts';
import { sharedArgs } from '../_shared-args.ts';
import { formatModelsList, splitUsageTokens } from '../command-utils.ts';
import { buildDailyReport } from '../daily-report.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';
import { resolveSessionSources } from '../session-sources.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show Codex token usage grouped by day',
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
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const sessionSources = resolveSessionSources(ctx.values.codexHome);
		const byAccount = ctx.values.byAccount === true;
		const hasMultipleAccounts = sessionSources.length > 1;
		const { events, missingDirectories } = await loadTokenUsageEvents({
			sessionSources,
		});

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			log(jsonOutput ? JSON.stringify({ daily: [], totals: null }) : 'No Codex usage data found.');
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
		});
		try {
			const rows = await buildDailyReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
				byAccount,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify({ daily: [], totals: null })
						: 'No Codex usage data found for provided filters.',
				);
				return;
			}

			const totals = rows.reduce(
				(acc, row) => {
					acc.inputTokens += row.inputTokens;
					acc.cachedInputTokens += row.cachedInputTokens;
					acc.outputTokens += row.outputTokens;
					acc.reasoningOutputTokens += row.reasoningOutputTokens;
					acc.totalTokens += row.totalTokens;
					acc.costUSD += row.costUSD;
					return acc;
				},
				{
					inputTokens: 0,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
					costUSD: 0,
				},
			);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							daily: rows,
							totals,
						},
						null,
						2,
					),
				);
				return;
			}

			logger.box(
				`Codex Token Usage Report - Daily (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			if (hasMultipleAccounts && !byAccount) {
				logger.info(
					'Aggregating usage across multiple accounts. Use --by-account to split rows by account.',
				);
			}

			const includeAccountColumn = byAccount;
			const head = includeAccountColumn
				? [
						'Date',
						'Account',
						'Models',
						'Input',
						'Output',
						'Reasoning',
						'Cache Read',
						'Total Tokens',
						'Cost (USD)',
					]
				: [
						'Date',
						'Models',
						'Input',
						'Output',
						'Reasoning',
						'Cache Read',
						'Total Tokens',
						'Cost (USD)',
					];
			const colAligns: TableCellAlign[] = includeAccountColumn
				? ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right']
				: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'];
			const compactHead = includeAccountColumn
				? ['Date', 'Account', 'Models', 'Input', 'Output', 'Cost (USD)']
				: ['Date', 'Models', 'Input', 'Output', 'Cost (USD)'];
			const compactColAligns: TableCellAlign[] = includeAccountColumn
				? ['left', 'left', 'left', 'right', 'right', 'right']
				: ['left', 'left', 'right', 'right', 'right'];
			const tableColumnCount = head.length;

			const table: ResponsiveTable = new ResponsiveTable({
				head,
				colAligns,
				compactHead,
				compactColAligns,
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});

			const totalsForDisplay = {
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				totalTokens: 0,
				costUSD: 0,
			};

			for (const row of rows) {
				const split = splitUsageTokens(row);
				totalsForDisplay.inputTokens += split.inputTokens;
				totalsForDisplay.outputTokens += split.outputTokens;
				totalsForDisplay.reasoningTokens += split.reasoningTokens;
				totalsForDisplay.cacheReadTokens += split.cacheReadTokens;
				totalsForDisplay.totalTokens += row.totalTokens;
				totalsForDisplay.costUSD += row.costUSD;

				if (includeAccountColumn) {
					table.push([
						row.date,
						row.account ?? 'default',
						formatModelsDisplayMultiline(formatModelsList(row.models)),
						formatNumber(split.inputTokens),
						formatNumber(split.outputTokens),
						formatNumber(split.reasoningTokens),
						formatNumber(split.cacheReadTokens),
						formatNumber(row.totalTokens),
						formatCurrency(row.costUSD),
					]);
				} else {
					table.push([
						row.date,
						formatModelsDisplayMultiline(formatModelsList(row.models)),
						formatNumber(split.inputTokens),
						formatNumber(split.outputTokens),
						formatNumber(split.reasoningTokens),
						formatNumber(split.cacheReadTokens),
						formatNumber(row.totalTokens),
						formatCurrency(row.costUSD),
					]);
				}
			}

			addEmptySeparatorRow(table, tableColumnCount);
			if (includeAccountColumn) {
				table.push([
					pc.yellow('Total'),
					'',
					'',
					pc.yellow(formatNumber(totalsForDisplay.inputTokens)),
					pc.yellow(formatNumber(totalsForDisplay.outputTokens)),
					pc.yellow(formatNumber(totalsForDisplay.reasoningTokens)),
					pc.yellow(formatNumber(totalsForDisplay.cacheReadTokens)),
					pc.yellow(formatNumber(totalsForDisplay.totalTokens)),
					pc.yellow(formatCurrency(totalsForDisplay.costUSD)),
				]);
			} else {
				table.push([
					pc.yellow('Total'),
					'',
					pc.yellow(formatNumber(totalsForDisplay.inputTokens)),
					pc.yellow(formatNumber(totalsForDisplay.outputTokens)),
					pc.yellow(formatNumber(totalsForDisplay.reasoningTokens)),
					pc.yellow(formatNumber(totalsForDisplay.cacheReadTokens)),
					pc.yellow(formatNumber(totalsForDisplay.totalTokens)),
					pc.yellow(formatCurrency(totalsForDisplay.costUSD)),
				]);
			}

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
