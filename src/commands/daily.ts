import process from 'node:process';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { groupByProject, groupDataByProject } from '../_daily-grouping.ts';
import { processWithJq } from '../_jq-processor.ts';
import { formatProjectName } from '../_project-names.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, pushBreakdownRows, ResponsiveTable } from '../_utils.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { formatDateCompact, loadDailyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show usage report grouped by date',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Show usage breakdown by project/instance',
			default: false,
		},
		project: {
			type: 'string',
			short: 'p',
			description: 'Filter to specific project name',
		},
	},
	async run(ctx) {
		// --jq implies --json
		const useJson = ctx.values.json || ctx.values.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const dailyData = await loadDailyUsageData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			groupByProject: ctx.values.instances,
			project: ctx.values.project,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
		});

		if (dailyData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(dailyData);

		// Show debug information if requested
		if (ctx.values.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (useJson) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = ctx.values.instances && dailyData.some(d => d.project != null)
				? {
						projects: groupByProject(dailyData),
						totals: createTotalsObject(totals),
					}
				: {
						daily: dailyData.map(data => ({
							date: data.date,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: getTotalTokens(data),
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
							modelBreakdowns: data.modelBreakdowns,
							...(data.project != null && { project: data.project }),
						})),
						totals: createTotalsObject(totals),
					};

			// Process with jq if specified
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error((jqResult.error).message);
					process.exit(1);
				}
				log(jqResult.value);
			}
			else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - Daily');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Date',
					'Models',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
				],
				style: {
					head: ['cyan'],
				},
				colAligns: [
					'left',
					'left',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
				],
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, ctx.values.timezone, ctx.values.locale),
				compactHead: [
					'Date',
					'Models',
					'Input',
					'Output',
					'Cost (USD)',
				],
				compactColAligns: [
					'left',
					'left',
					'right',
					'right',
					'right',
				],
				compactThreshold: 100,
			});

			// Add daily data - group by project if instances flag is used
			if (ctx.values.instances && dailyData.some(d => d.project != null)) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(dailyData);

				let isFirstProject = true;
				for (const [projectName, projectData] of Object.entries(projectGroups)) {
					// Add project section header
					if (!isFirstProject) {
						// Add empty row for visual separation between projects
						table.push(['', '', '', '', '', '', '', '']);
					}

					// Add project header row
					table.push([
						pc.cyan(`Project: ${formatProjectName(projectName)}`),
						'',
						'',
						'',
						'',
						'',
						'',
						'',
					]);

					// Add data rows for this project
					for (const data of projectData) {
						table.push([
							data.date,
							formatModelsDisplayMultiline(data.modelsUsed),
							formatNumber(data.inputTokens),
							formatNumber(data.outputTokens),
							formatNumber(data.cacheCreationTokens),
							formatNumber(data.cacheReadTokens),
							formatNumber(getTotalTokens(data)),
							formatCurrency(data.totalCost),
						]);

						// Add model breakdown rows if flag is set
						if (ctx.values.breakdown) {
							pushBreakdownRows(table, data.modelBreakdowns);
						}
					}

					isFirstProject = false;
				}
			}
			else {
				// Standard display without project grouping
				for (const data of dailyData) {
					// Main row
					table.push([
						data.date,
						formatModelsDisplayMultiline(data.modelsUsed),
						formatNumber(data.inputTokens),
						formatNumber(data.outputTokens),
						formatNumber(data.cacheCreationTokens),
						formatNumber(data.cacheReadTokens),
						formatNumber(getTotalTokens(data)),
						formatCurrency(data.totalCost),
					]);

					// Add model breakdown rows if flag is set
					if (ctx.values.breakdown) {
						pushBreakdownRows(table, data.modelBreakdowns);
					}
				}
			}

			// Add empty row for visual separation before totals
			table.push([
				'',
				'',
				'',
				'',
				'',
				'',
				'',
				'',
			]);

			// Add totals
			table.push([
				pc.yellow('Total'),
				'', // Empty for Models column in totals
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(totals))),
				pc.yellow(formatCurrency(totals.totalCost)),
			]);

			log(table.toString());

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});
