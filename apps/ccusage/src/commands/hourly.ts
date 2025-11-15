import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_LOCALE } from '../_consts.ts';
import { processWithJq } from '../_jq-processor.ts';
import { formatProjectName } from '../_project-names.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import {
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { loadHourlyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const hourlyCommand = define({
	name: 'hourly',
	description: 'Show usage report grouped by hour (last 24 hours)',
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
		projectAliases: {
			type: 'string',
			description: 'Comma-separated project aliases (e.g., \'ccusage=Usage Tracker,myproject=My Project\')',
			hidden: true,
		},
		today: {
			type: 'boolean',
			short: 't',
			description: 'Show only hours from today (current calendar day in configured timezone)',
			default: false,
		},
	},
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// Convert projectAliases to Map if it exists
		let projectAliases: Map<string, string> | undefined;
		if (mergedOptions.projectAliases != null && typeof mergedOptions.projectAliases === 'string') {
			projectAliases = new Map();
			const pairs = mergedOptions.projectAliases.split(',').map(pair => pair.trim()).filter(pair => pair !== '');
			for (const pair of pairs) {
				const parts = pair.split('=').map(s => s.trim());
				const rawName = parts[0];
				const alias = parts[1];
				if (rawName != null && alias != null && rawName !== '' && alias !== '') {
					projectAliases.set(rawName, alias);
				}
			}
		}

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		let hourlyData = await loadHourlyUsageData({
			...mergedOptions,
			groupByProject: mergedOptions.instances,
		});

		// Filter to today only if --today flag is set
		if (mergedOptions.today) {
			// Get today's date in the configured timezone
			const now = new Date();
			const formatter = new Intl.DateTimeFormat(mergedOptions.locale ?? DEFAULT_LOCALE, {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				timeZone: mergedOptions.timezone,
			});
			const parts = formatter.formatToParts(now);
			const year = parts.find(p => p.type === 'year')?.value ?? '';
			const month = parts.find(p => p.type === 'month')?.value ?? '';
			const day = parts.find(p => p.type === 'day')?.value ?? '';
			const todayDate = `${year}-${month}-${day}`;

			// Filter hours to only include those from today
			hourlyData = hourlyData.filter(hour => hour.hour.startsWith(todayDate));
		}

		if (hourlyData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			}
			else {
				const timeframe = mergedOptions.today ? 'today' : 'in the last 24 hours';
				logger.warn(`No Claude usage data found ${timeframe}.`);
			}
			process.exit(0);
		}

		// Calculate totals locally (hourly data is not part of Daily/Monthly/Weekly/Session unions)
		const totals = hourlyData.reduce(
			(acc, item) => ({
				inputTokens: acc.inputTokens + item.inputTokens,
				outputTokens: acc.outputTokens + item.outputTokens,
				cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
				cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
				totalCost: acc.totalCost + item.totalCost,
			}),
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
			},
		);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				hourly: hourlyData.map(data => ({
					hour: data.hour,
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
			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(jsonOutput, mergedOptions.jq);
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
			logger.box('Claude Code Token Usage Report - Hourly (Last 24 Hours)');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Hour',
				forceCompact: ctx.values.compact,
			};
			const table = createUsageReportTable(tableConfig);

			// Group by project if instances flag is used
			if (Boolean(mergedOptions.instances) && hourlyData.some(d => d.project != null)) {
				const projectGroups: Record<string, typeof hourlyData> = {};
				for (const data of hourlyData) {
					const projectName = data.project ?? 'unknown';
					if (projectGroups[projectName] == null) {
						projectGroups[projectName] = [];
					}
					projectGroups[projectName].push(data);
				}

				let isFirstProject = true;
				for (const [projectName, projectData] of Object.entries(projectGroups)) {
					if (!isFirstProject) {
						addEmptySeparatorRow(table, 8);
					}

					table.push([
						pc.cyan(`Project: ${formatProjectName(projectName, projectAliases)}`),
						'',
						'',
						'',
						'',
						'',
						'',
						'',
					]);

					for (const data of projectData) {
						const row = formatUsageDataRow(data.hour, {
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
						});
						table.push(row);

						if (mergedOptions.breakdown) {
							pushBreakdownRows(table, data.modelBreakdowns);
						}
					}

					isFirstProject = false;
				}
			}
			else {
				// Standard display
				for (const data of hourlyData) {
					const row = formatUsageDataRow(data.hour, {
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						modelsUsed: data.modelsUsed,
					});
					table.push(row);

					if (mergedOptions.breakdown) {
						pushBreakdownRows(table, data.modelBreakdowns);
					}
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, 8);

			// Add totals
			const totalsRow = formatTotalsRow({
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
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
