import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { loadMonthlyUsageData } from '../adapter/claude/data-loader.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadConfig, mergeConfigWithArgs } from '../config-loader-tokens.ts';
import { formatDateCompact } from '../date-utils.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { logger, writeStdoutLine } from '../logger.ts';
import { sharedCommandConfig } from '../shared-args.ts';
import { createUsageLoadProgress, shouldShowUsageLoadProgress } from './loading-progress.ts';

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show usage report grouped by month',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		prompts: {
			type: 'boolean',
			description: 'Show prompt count column (number of usage-bearing entries per bucket)',
			default: false,
		},
	},
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		const useJson = Boolean(mergedOptions.json);
		const originalLoggerLevel = logger.level;
		if (useJson) {
			logger.level = 0;
		}

		const progress = createUsageLoadProgress(
			shouldShowUsageLoadProgress(mergedOptions, process.stdout),
		);
		let monthlyData: Awaited<ReturnType<typeof loadMonthlyUsageData>>;
		try {
			if (progress != null) {
				logger.level = 0;
			}
			progress?.start('claude');
			monthlyData = await loadMonthlyUsageData(mergedOptions);
			progress?.succeed('claude', monthlyData.length);
		} catch (error) {
			progress?.fail('claude', error);
			throw error;
		} finally {
			progress?.stop();
			logger.level = originalLoggerLevel;
		}

		const includePrompts = Boolean(mergedOptions.prompts);

		if (monthlyData.length === 0) {
			if (useJson) {
				const emptyOutput = {
					monthly: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalTokens: 0,
						totalCost: 0,
						...(includePrompts && { promptCount: 0 }),
					},
				};
				await writeStdoutLine(JSON.stringify(emptyOutput, null, 2));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(monthlyData);
		const totalPromptCount = monthlyData.reduce((sum, month) => sum + month.promptCount, 0);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				monthly: monthlyData.map((data) => ({
					month: data.month,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					...(includePrompts && { promptCount: data.promptCount }),
				})),
				totals: {
					...createTotalsObject(totals),
					...(includePrompts && { promptCount: totalPromptCount }),
				},
			};

			await writeStdoutLine(JSON.stringify(jsonOutput, null, 2));
		} else {
			// Print header
			logger.box('Claude Code Token Usage Report - Monthly');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Month',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, mergedOptions.timezone),
				forceCompact: ctx.values.compact,
				includePrompts,
			};
			const table = createUsageReportTable(tableConfig);
			const columnCount = 8 + (includePrompts ? 1 : 0);

			// Add monthly data
			for (const data of monthlyData) {
				// Main row
				const row = formatUsageDataRow(data.month, {
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					...(includePrompts && { promptCount: data.promptCount }),
				});
				table.push(row);

				// Add model breakdown rows if flag is set
				if (mergedOptions.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns, includePrompts ? 2 : 1);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, columnCount);

			// Add totals
			const totalsRow = formatTotalsRow({
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
				...(includePrompts && { promptCount: totalPromptCount }),
			});
			table.push(totalsRow);

			const renderedTable = table.toString();

			await writeStdoutLine(renderedTable);

			if (table.isCompactMode()) {
				await writeStdoutLine();
				logger.info('Running in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});
