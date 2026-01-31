import path from 'node:path';
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
import { loadPiAgentSessionData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export const sessionCommand = define({
	name: 'session',
	description: 'Show pi-agent usage by session',
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

		const piData = await loadPiAgentSessionData(options);

		if (piData.length === 0) {
			if (ctx.values.json) {
				const totals = {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalTokens: 0,
					totalCost: 0,
				};
				log(JSON.stringify({ sessions: [], totals }, null, 2));
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
						sessions: piData,
						totals,
					},
					null,
					2,
				),
			);
		} else {
			logger.box('Pi-Agent Usage Report - Sessions');

			const table = createUsageReportTable({
				firstColumnName: 'Session',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});

			for (const data of piData) {
				const projectName = path.basename(data.projectPath);
				const truncatedName =
					projectName.length > 25 ? `${projectName.slice(0, 22)}...` : projectName;

				const row = formatUsageDataRow(truncatedName, {
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
