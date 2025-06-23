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
import { formatDateCompact, loadSessionData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Group session usage data by project for JSON output
 */
function groupByProject(sessionData: ReturnType<typeof loadSessionData> extends Promise<infer T> ? T : never): Record<string, any[]> {
	const projects: Record<string, any[]> = {};

	for (const data of sessionData) {
		const projectName = data.projectPath ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push({
			sessionId: data.sessionId,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			cacheCreationTokens: data.cacheCreationTokens,
			cacheReadTokens: data.cacheReadTokens,
			totalTokens: getTotalTokens(data),
			totalCost: data.totalCost,
			lastActivity: data.lastActivity,
			modelsUsed: data.modelsUsed,
			modelBreakdowns: data.modelBreakdowns,
		});
	}

	return projects;
}

/**
 * Group session usage data by project for table display
 */
function groupDataByProject(sessionData: ReturnType<typeof loadSessionData> extends Promise<infer T> ? T : never): Record<string, typeof sessionData> {
	const projects: Record<string, typeof sessionData> = {};

	for (const data of sessionData) {
		const projectName = data.projectPath ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push(data);
	}

	return projects;
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			groupByProject: ctx.values.instances,
			project: ctx.values.project,
		});

		if (sessionData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = ctx.values.instances
				? {
						projects: groupByProject(sessionData),
						totals: createTotalsObject(totals),
					}
				: {
						sessions: sessionData.map(data => ({
							sessionId: data.sessionId,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: getTotalTokens(data),
							totalCost: data.totalCost,
							lastActivity: data.lastActivity,
							modelsUsed: data.modelsUsed,
							modelBreakdowns: data.modelBreakdowns,
							projectPath: data.projectPath,
						})),
						totals: createTotalsObject(totals),
					};
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Session',
					'Models',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
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
					'left',
				],
				dateFormatter: formatDateCompact,
				compactHead: [
					'Session',
					'Models',
					'Input',
					'Output',
					'Cost (USD)',
					'Last Activity',
				],
				compactColAligns: [
					'left',
					'left',
					'right',
					'right',
					'right',
					'left',
				],
				compactThreshold: 100,
			});

			// Add session data - group by project if instances flag is used
			if (ctx.values.instances) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(sessionData);

				let isFirstProject = true;
				for (const [projectName, projectData] of Object.entries(projectGroups)) {
					// Add project section header
					if (!isFirstProject) {
						// Add empty row for visual separation between projects
						table.push(['', '', '', '', '', '', '', '', '']);
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
						'',
					]);

					// Add data rows for this project
					for (const data of projectData) {
						const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

						table.push([
							sessionDisplay,
							formatModelsDisplayMultiline(data.modelsUsed),
							formatNumber(data.inputTokens),
							formatNumber(data.outputTokens),
							formatNumber(data.cacheCreationTokens),
							formatNumber(data.cacheReadTokens),
							formatNumber(getTotalTokens(data)),
							formatCurrency(data.totalCost),
							data.lastActivity,
						]);

						// Add model breakdown rows if flag is set
						if (ctx.values.breakdown) {
							// Session has 1 extra column before data and 1 trailing column
							pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
						}
					}

					isFirstProject = false;
				}
			}
			else {
				// Standard display without project grouping
				let maxSessionLength = 0;
				for (const data of sessionData) {
					const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

					maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

					// Main row
					table.push([
						sessionDisplay,
						formatModelsDisplayMultiline(data.modelsUsed),
						formatNumber(data.inputTokens),
						formatNumber(data.outputTokens),
						formatNumber(data.cacheCreationTokens),
						formatNumber(data.cacheReadTokens),
						formatNumber(getTotalTokens(data)),
						formatCurrency(data.totalCost),
						data.lastActivity,
					]);

					// Add model breakdown rows if flag is set
					if (ctx.values.breakdown) {
						// Session has 1 extra column before data and 1 trailing column
						pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
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
				'',
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
