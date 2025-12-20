import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@ccusage/terminal/table';
import { loadSessionData } from 'ccusage/data-loader';
import { log, logger } from 'ccusage/logger';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadPiAgentSessionData } from '../data-loader.ts';

export const sessionCommand = define({
	name: 'session',
	description: 'Show combined Claude Code + pi-agent usage by session',
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
			loadSessionData(options),
			loadPiAgentSessionData(options),
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
			const cmp = a.lastActivity.localeCompare(b.lastActivity);
			return options.order === 'asc' ? cmp : -cmp;
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
				sessions: combined,
				totals,
			}, null, 2));
		}
		else {
			logger.box('Claude Code + Pi-Agent Usage Report - Sessions');

			const table = createUsageReportTable({
				firstColumnName: 'Session',
				dateFormatter: (str: string) => str,
			});

			for (const data of combined) {
				const sourceLabel = data.source === 'pi-agent' ? pc.cyan('[pi]') : pc.green('[cc]');
				const projectName = data.projectPath.split('/').pop() ?? data.projectPath;
				const truncatedName = projectName.length > 25 ? `${projectName.slice(0, 22)}...` : projectName;
				const firstCol = `${truncatedName} ${sourceLabel}`;

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
