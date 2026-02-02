import type { MonthlyReportRow } from '../_types.ts';
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
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { buildMonthlyReport } from '../monthly-report.ts';
import { CodexPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

type MonthlyDisplayTotals = {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
};

/**
 * Create a zeroed display totals accumulator for monthly table output.
 */
function createMonthlyDisplayTotals(): MonthlyDisplayTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		totalCost: 0,
	};
}

/**
 * Update display totals using a pre-split row for monthly output.
 */
function updateMonthlyDisplayTotals(
	totals: MonthlyDisplayTotals,
	row: MonthlyReportRow,
	split: ReturnType<typeof splitUsageTokens>,
): void {
	totals.inputTokens += split.inputTokens;
	totals.outputTokens += split.outputTokens;
	totals.reasoningTokens += split.reasoningTokens;
	totals.cacheReadTokens += split.cacheReadTokens;
	totals.totalTokens += row.totalTokens;
	totals.totalCost += row.totalCost;
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show Codex token usage grouped by month',
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

		const { events, missingDirectories } = await loadTokenUsageEvents();

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			if (jsonOutput) {
				const emptyTotals = {
					inputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
					totalCost: 0,
				};
				log(JSON.stringify({ monthly: [], totals: emptyTotals }, null, 2));
			} else {
				log('No Codex usage data found.');
			}
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
		});
		try {
			const rows = await buildMonthlyReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify(
								{
									monthly: [],
									totals: {
										inputTokens: 0,
										cacheCreationTokens: 0,
										cacheReadTokens: 0,
										outputTokens: 0,
										reasoningOutputTokens: 0,
										totalTokens: 0,
										totalCost: 0,
									},
								},
								null,
								2,
							)
						: 'No Codex usage data found for provided filters.',
				);
				return;
			}

			const totals = rows.reduce(
				(acc, row) => {
					acc.inputTokens += row.inputTokens;
					acc.cacheCreationTokens += row.cacheCreationTokens;
					acc.cacheReadTokens += row.cacheReadTokens;
					acc.outputTokens += row.outputTokens;
					acc.reasoningOutputTokens += row.reasoningOutputTokens;
					acc.totalTokens += row.totalTokens;
					acc.totalCost += row.totalCost;
					return acc;
				},
				{
					inputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
					totalCost: 0,
				},
			);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							monthly: rows,
							totals,
						},
						null,
						2,
					),
				);
				return;
			}

			logger.box(
				`Codex Token Usage Report - Monthly (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Month',
					'Models',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
				],
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
				compactHead: ['Month', 'Models', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});

			const totalsForDisplay = createMonthlyDisplayTotals();

			for (const row of rows) {
				const split = splitUsageTokens(row);
				updateMonthlyDisplayTotals(totalsForDisplay, row, split);

				table.push([
					row.month,
					formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(split.inputTokens),
					formatNumber(split.outputTokens),
					formatNumber(split.reasoningTokens),
					formatNumber(split.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.totalCost),
				]);
			}

			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(totalsForDisplay.inputTokens)),
				pc.yellow(formatNumber(totalsForDisplay.outputTokens)),
				pc.yellow(formatNumber(totalsForDisplay.reasoningTokens)),
				pc.yellow(formatNumber(totalsForDisplay.cacheReadTokens)),
				pc.yellow(formatNumber(totalsForDisplay.totalTokens)),
				pc.yellow(formatCurrency(totalsForDisplay.totalCost)),
			]);

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

if (import.meta.vitest != null) {
	describe('updateMonthlyDisplayTotals', () => {
		it('tracks totalCost instead of legacy costUSD', () => {
			const row: MonthlyReportRow = {
				month: '2025-01',
				inputTokens: 100,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 50,
				reasoningOutputTokens: 10,
				totalTokens: 150,
				totalCost: 1.5,
				costUSD: 99,
				models: {
					'gpt-5': {
						inputTokens: 100,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						outputTokens: 50,
						reasoningOutputTokens: 10,
						totalTokens: 150,
					},
				},
			};

			const totals = createMonthlyDisplayTotals();
			const split = splitUsageTokens(row);
			updateMonthlyDisplayTotals(totals, row, split);

			expect(totals.totalCost).toBe(1.5);
			expect(totals.totalCost).not.toBe(row.costUSD);
		});
	});
}
