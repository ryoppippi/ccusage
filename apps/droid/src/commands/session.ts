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
import {
	formatDisplayDate,
	formatDisplayDateTime,
	normalizeFilterDate,
	toDateKey,
} from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { FactoryPricingSource } from '../pricing.ts';
import { buildSessionReport } from '../session-report.ts';

const TABLE_COLUMN_COUNT = 12;

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

export const sessionCommand = define({
	name: 'session',
	description: 'Show Factory Droid token usage grouped by session',
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
				jsonOutput
					? JSON.stringify({ sessions: [], totals: null })
					: 'No Factory usage data found.',
			);
			return;
		}

		const pricingSource = new FactoryPricingSource({ offline: ctx.values.offline });
		try {
			const report = await buildSessionReport(events, {
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
						? JSON.stringify({ sessions: [], totals: null })
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
							sessions: rows,
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
				`Factory Droid Usage Report - Sessions (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Date',
					'Directory',
					'Session',
					'Models',
					'Input',
					'Output',
					'Thinking',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
				],
				colAligns: [
					'left',
					'left',
					'left',
					'left',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'left',
				],
				compactHead: ['Date', 'Directory', 'Session', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'left', 'right', 'right', 'right'],
				compactThreshold: 120,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
			});

			for (const row of rows) {
				const dateKey = toDateKey(row.lastActivity, ctx.values.timezone);
				const displayDate = formatDisplayDate(dateKey, ctx.values.locale, ctx.values.timezone);
				const directoryDisplay = row.directory === '' ? '-' : row.directory;
				const shortSession =
					row.sessionId.length > 8 ? `…${row.sessionId.slice(-8)}` : row.sessionId;

				table.push([
					displayDate,
					directoryDisplay,
					shortSession,
					formatModelsDisplayMultiline(row.modelsUsed),
					formatNumber(row.inputTokens),
					formatNumber(row.outputTokens),
					formatNumber(row.thinkingTokens),
					formatNumber(row.cacheCreationTokens),
					formatNumber(row.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
					formatDisplayDateTime(row.lastActivity, ctx.values.locale, ctx.values.timezone),
				]);
			}

			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				'',
				'',
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.thinkingTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(totals.totalTokens)),
				pc.yellow(formatCurrency(totals.costUSD)),
				'',
			]);

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info(
					'Expand terminal width to see cache metrics, thinking tokens, total tokens, and last activity',
				);
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
