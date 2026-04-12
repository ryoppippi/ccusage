import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import { withComparisonCosts } from '../_compare-model.ts';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { WEEK_DAYS } from '../_consts.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedArgs } from '../_shared-args.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadWeeklyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const weeklyCommand = define({
	name: 'weekly',
	description: 'Show usage report grouped by week',
	args: {
		...sharedArgs,
		startOfWeek: {
			type: 'enum',
			short: 'w',
			description: 'Day to start the week on',
			default: 'sunday' as const,
			choices: WEEK_DAYS,
		},
	},
	toKebab: true,
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const rawWeeklyData = await loadWeeklyUsageData(mergedOptions);
		const weeklyData = await withComparisonCosts(
			rawWeeklyData,
			mergedOptions.compareModel,
			mergedOptions.offline,
		);

		if (weeklyData.length === 0) {
			if (useJson) {
				const emptyOutput = {
					weekly: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalTokens: 0,
						totalCost: 0,
						...(mergedOptions.compareModel != null && {
							comparisonCost: 0,
							comparisonModelName: mergedOptions.compareModel,
						}),
					},
				};
				log(JSON.stringify(emptyOutput, null, 2));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(weeklyData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				weekly: weeklyData.map((data) => ({
					week: data.week,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					...(data.comparisonCost != null && { comparisonCost: data.comparisonCost }),
					...(data.comparisonModelName != null && {
						comparisonModelName: data.comparisonModelName,
					}),
				})),
				totals: {
					...createTotalsObject(totals),
					...(mergedOptions.compareModel != null && {
						comparisonCost: weeklyData.reduce((sum, d) => sum + (d.comparisonCost ?? 0), 0),
						comparisonModelName: mergedOptions.compareModel,
					}),
				},
			};

			// Process with jq if specified
			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(jsonOutput, mergedOptions.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
			} else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		} else {
			// Print header
			logger.box('Claude Code Token Usage Report - Weekly');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Week',
				dateFormatter: (dateStr: string) =>
					formatDateCompact(dateStr, mergedOptions.timezone, mergedOptions.locale ?? undefined),
				forceCompact: ctx.values.compact,
				comparisonModelName: mergedOptions.compareModel,
			};
			const table = createUsageReportTable(tableConfig);

			// Add weekly data
			for (const data of weeklyData) {
				// Main row
				const row = formatUsageDataRow(data.week, {
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					comparisonCost: data.comparisonCost,
				});
				table.push(row);

				// Add model breakdown rows if flag is set
				if (mergedOptions.breakdown) {
					pushBreakdownRows(
						table,
						data.modelBreakdowns,
						1,
						tableConfig.comparisonModelName != null ? 2 : 0,
					);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, tableConfig.comparisonModelName != null ? 10 : 8);

			// Add totals
			const totalsRow = formatTotalsRow({
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
				...(mergedOptions.compareModel != null && {
					comparisonCost: weeklyData.reduce((sum, d) => sum + (d.comparisonCost ?? 0), 0),
				}),
			});
			table.push(totalsRow);

			log(table.toString());

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});
