import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { formatProjectName } from '../_project-names.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, pushBreakdownRows, ResponsiveTable } from '../_utils.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { formatDateCompact, loadMonthlyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Group monthly usage data by project for JSON output
 */
function groupByProject(monthlyData: ReturnType<typeof loadMonthlyUsageData> extends Promise<infer T> ? T : never): Record<string, any[]> {
	const projects: Record<string, any[]> = {};

	for (const data of monthlyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push({
			month: data.month,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			cacheCreationTokens: data.cacheCreationTokens,
			cacheReadTokens: data.cacheReadTokens,
			totalTokens: getTotalTokens(data),
			totalCost: data.totalCost,
			modelsUsed: data.modelsUsed,
			modelBreakdowns: data.modelBreakdowns,
		});
	}

	return projects;
}

/**
 * Group monthly usage data by project for table display
 */
function groupDataByProject(monthlyData: ReturnType<typeof loadMonthlyUsageData> extends Promise<infer T> ? T : never): Record<string, typeof monthlyData> {
	const projects: Record<string, typeof monthlyData> = {};

	for (const data of monthlyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push(data);
	}

	return projects;
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show usage report grouped by month',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const monthlyData = await loadMonthlyUsageData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			groupByProject: ctx.values.instances,
			project: ctx.values.project,
		});

		if (monthlyData.length === 0) {
			if (ctx.values.json) {
				const emptyOutput = {
					monthly: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalTokens: 0,
						totalCost: 0,
					},
				};
				log(JSON.stringify(emptyOutput, null, 2));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(monthlyData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = ctx.values.instances && monthlyData.some(d => d.project != null)
				? {
						projects: groupByProject(monthlyData),
						totals: createTotalsObject(totals),
					}
				: {
						monthly: monthlyData.map(data => ({
							month: data.month,
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
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - Monthly');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Month',
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
				dateFormatter: formatDateCompact,
				compactHead: [
					'Month',
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

			// Add monthly data - group by project if instances flag is used
			if (ctx.values.instances && monthlyData.some(d => d.project != null)) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(monthlyData);

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
							data.month,
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
				for (const data of monthlyData) {
					// Main row
					table.push([
						data.month,
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
