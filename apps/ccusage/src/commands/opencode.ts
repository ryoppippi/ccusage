import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import { groupBy } from 'es-toolkit';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { loadOpenCodeMessages } from '../_opencode-data-loader.ts';
import { log, logger } from '../logger.ts';
import { DEFAULT_LOCALE } from '../_consts.ts';
import { formatDate } from '../_date-utils.ts';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';

export const opencodeCommand = define({
	name: 'opencode',
	description: 'Show OpenCode usage report grouped by date',
	...sharedCommandConfig,
	async run(ctx: any) {
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const openCodeEntries = await loadOpenCodeMessages();

		if (openCodeEntries.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No OpenCode usage data found.');
			}
			process.exit(0);
		}

		// Aggregate by date
		const entriesByDate = groupBy(
			openCodeEntries,
			(entry: any) => formatDate(entry.timestamp, mergedOptions.timezone as any, DEFAULT_LOCALE),
		) as Record<string, any[]>;

		// Convert to daily usage format
		const dailyData: Array<{
			date: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdowns: Array<{
				modelName: string;
				inputTokens: number;
				outputTokens: number;
				cacheCreationTokens: number;
				cacheReadTokens: number;
				cost: number;
			}>;
		}> = [];

		for (const [date, entries] of Object.entries(entriesByDate)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelMap = new Map<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					cacheCreationTokens: number;
					cacheReadTokens: number;
					cost: number;
				}
			>();

			for (const entry of entries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += entry.costUSD ?? 0;

				if (!modelMap.has(entry.model)) {
					modelMap.set(entry.model, {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0,
					});
				}

				const modelData = modelMap.get(entry.model)!;
				modelData.inputTokens += entry.usage.inputTokens;
				modelData.outputTokens += entry.usage.outputTokens;
				modelData.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				modelData.cacheReadTokens += entry.usage.cacheReadInputTokens;
				modelData.cost += entry.costUSD ?? 0;
			}

			const modelBreakdowns = Array.from(modelMap.entries()).map(([modelName, data]) => ({
				modelName,
				inputTokens: data.inputTokens,
				outputTokens: data.outputTokens,
				cacheCreationTokens: data.cacheCreationTokens,
				cacheReadTokens: data.cacheReadTokens,
				cost: data.cost,
			}));

			dailyData.push({
				date,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelMap.keys()),
				modelBreakdowns,
			});
		}

		// Sort by date
		dailyData.sort((a, b) => a.date.localeCompare(b.date));

		// Calculate totals
		const totals = {
			inputTokens: dailyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: dailyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: dailyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: dailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: dailyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (useJson) {
			const jsonOutput = {
				opencode: dailyData.map(data => ({
					date: data.date,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				})),
				totals: {
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					cacheCreationTokens: totals.cacheCreationTokens,
					cacheReadTokens: totals.cacheReadTokens,
					totalTokens: totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens,
					totalCost: totals.totalCost,
				},
			};

			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(JSON.stringify(jsonOutput), (mergedOptions.jq as any));
				if (Result.isFailure(jqResult)) {
					logger.error((jqResult.error as any).message);
					process.exit(1);
				}
				log(jqResult.value);
			}
			else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		}
		else {
			logger.box('OpenCode Token Usage Report - Daily');

			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Date',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, mergedOptions.timezone as any, (mergedOptions.locale as any) ?? undefined),
				forceCompact: (ctx.values as any).compact,
			};
			const table = createUsageReportTable(tableConfig);

			for (const data of dailyData) {
				formatUsageDataRow(table, {
					key: data.date,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
				});

				if (mergedOptions.breakdown && data.modelBreakdowns.length > 0) {
					pushBreakdownRows(table, data.modelBreakdowns);
				}
			}

			addEmptySeparatorRow(table);
			formatTotalsRow(table, {
				label: 'Total',
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
			});

			log(table.toString());
		}
	},
});
