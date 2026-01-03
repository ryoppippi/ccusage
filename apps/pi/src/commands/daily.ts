import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@ccusage/terminal/table';
import { loadDailyUsageData } from 'ccusage/data-loader';
import { log, logger } from 'ccusage/logger';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadPiAgentDailyData } from '../data-loader.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show combined Claude Code + pi-agent usage by date',
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

		const [ccData, piData] = await Promise.all([
			loadDailyUsageData(options),
			loadPiAgentDailyData(options),
		]);

		const ccDataWithSource = ccData.map(d => ({
			...d,
			source: 'claude-code' as const,
		}));

		const combined = [...ccDataWithSource, ...piData];

		if (combined.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No usage data found.');
			}
			process.exit(0);
		}

		combined.sort((a, b) => {
			const cmp = a.date.localeCompare(b.date);
			if (cmp !== 0) {
				return options.order === 'asc' ? cmp : -cmp;
			}
			return a.source === 'claude-code' ? -1 : 1;
		});

		const totals = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		};

		for (const d of combined) {
			totals.inputTokens += d.inputTokens;
			totals.outputTokens += d.outputTokens;
			totals.cacheCreationTokens += d.cacheCreationTokens;
			totals.cacheReadTokens += d.cacheReadTokens;
			totals.totalCost += d.totalCost;
		}

		if (ctx.values.json) {
			log(JSON.stringify({
				daily: combined,
				totals,
			}, null, 2));
		}
		else {
			logger.box('Claude Code + Pi-Agent Usage Report - Daily');

			const table = createUsageReportTable({
				firstColumnName: 'Date',
				dateFormatter: (str: string) => str,
			});

			let prevDate = '';
			for (const data of combined) {
				const isNewDate = data.date !== prevDate;
				prevDate = data.date;

				const sourceLabel = data.source === 'pi-agent' ? pc.cyan('[pi]') : pc.green('[cc]');
				const firstCol = isNewDate ? `${data.date} ${sourceLabel}` : sourceLabel;

				const row = formatUsageDataRow(firstCol, {
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
