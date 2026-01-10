/**
 * @fileoverview `monthly` command for Factory Droid usage.
 */

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
import { loadFactoryTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { buildMonthlyReport } from '../monthly-report.ts';
import { FactoryPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 9;

function summarizeMissingPricing(models: string[]): void {
	if (models.length === 0) {
		return;
	}
	const preview = models.slice(0, 5).join(', ');
	const suffix = models.length > 5 ? ', …' : '';
	logger.warn(
		`Missing pricing for ${models.length} models (cost treated as $0): ${preview}${suffix}`,
	);
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show Factory Droid token usage grouped by month',
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

		const { events, missingLogsDirectory } = await loadFactoryTokenUsageEvents({
			factoryDir: ctx.values.factoryDir,
		});
		if (missingLogsDirectory != null) {
			logger.warn(`Factory logs directory not found: ${missingLogsDirectory}`);
		}

		if (events.length === 0) {
			log(
				jsonOutput ? JSON.stringify({ monthly: [], totals: null }) : 'No Factory usage data found.',
			);
			return;
		}

		const pricingSource = new FactoryPricingSource({ offline: ctx.values.offline });
		try {
			const report = await buildMonthlyReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
			});

			const rows = report.rows;
			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify({ monthly: [], totals: null })
						: 'No Factory usage data found for provided filters.',
				);
				return;
			}

			summarizeMissingPricing(report.missingPricingModels);

			const totals = rows.reduce(
				(acc, row) => {
					acc.inputTokens += row.inputTokens;
					acc.outputTokens += row.outputTokens;
					acc.thinkingTokens += row.thinkingTokens;
					acc.cacheReadTokens += row.cacheReadTokens;
					acc.cacheCreationTokens += row.cacheCreationTokens;
					acc.totalTokens += row.totalTokens;
					acc.costUSD += row.costUSD;
					return acc;
				},
				{
					inputTokens: 0,
					outputTokens: 0,
					thinkingTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					totalTokens: 0,
					costUSD: 0,
				},
			);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							monthly: rows,
							totals,
							missingPricingModels: report.missingPricingModels,
						},
						null,
						2,
					),
				);
				return;
			}

			logger.box(
				`Factory Droid Usage Report - Monthly (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Month',
					'Models',
					'Input',
					'Output',
					'Thinking',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
				],
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
				compactHead: ['Month', 'Models', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
			});

			for (const row of rows) {
				table.push([
					row.month,
					formatModelsDisplayMultiline(row.modelsUsed),
					formatNumber(row.inputTokens),
					formatNumber(row.outputTokens),
					formatNumber(row.thinkingTokens),
					formatNumber(row.cacheCreationTokens),
					formatNumber(row.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
				]);
			}

			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.thinkingTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(totals.totalTokens)),
				pc.yellow(formatCurrency(totals.costUSD)),
			]);

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info(
					'Expand terminal width to see cache metrics, thinking tokens, and total tokens',
				);
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
