import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatDateCompact,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { loadPiAgentMonthlyData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show pi-agent usage by month',
	args: {
		json: {
			type: 'boolean',
			description: 'Output as JSON',
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
		timezone: {
			type: 'string',
			short: 'z',
			description: 'Timezone for date display',
		},
		piPath: {
			type: 'string',
			description: 'Path to pi-agent sessions directory',
		},
		order: {
			type: 'string',
			description: 'Sort order: asc or desc',
			default: 'desc',
		},
		breakdown: {
			type: 'boolean',
			short: 'b',
			description: 'Show model breakdown for each entry',
			default: false,
		},
	},
	async run(ctx) {
		const options = {
			since: ctx.values.since,
			until: ctx.values.until,
			timezone: ctx.values.timezone,
			order: ctx.values.order as 'asc' | 'desc',
			piPath: ctx.values.piPath,
		};

		const piData = await loadPiAgentMonthlyData(options);

		if (piData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			} else {
				logger.warn('No usage data found.');
			}
			process.exit(0);
		}

		const totals = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
			totalCost: 0,
		};

		for (const d of piData) {
			totals.inputTokens += d.inputTokens;
			totals.outputTokens += d.outputTokens;
			totals.cacheCreationTokens += d.cacheCreationTokens;
			totals.cacheReadTokens += d.cacheReadTokens;
			totals.totalTokens +=
				d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
			totals.totalCost += d.totalCost;
		}

		if (ctx.values.json) {
			log(
				JSON.stringify(
					{
						monthly: piData,
						totals,
					},
					null,
					2,
				),
			);
		} else {
			logger.box('Pi-Agent Usage Report - Monthly');

			const table = createUsageReportTable({
				firstColumnName: 'Month',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});

			for (const data of piData) {
				const row = formatUsageDataRow(data.month, {
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
				});
				table.push(row);

				if (ctx.values.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns);
				}
			}

			addEmptySeparatorRow(table, 8);

			const totalsRow = formatTotalsRow({
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
			});
			table.push(totalsRow);

			log(table.toString());
		}
	},
});
