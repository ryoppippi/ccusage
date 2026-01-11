import type { ChartDataEntry } from '@ccusage/terminal/charts';
import type { UsageReportConfig } from '@ccusage/terminal/table';
import type { DailyUsage } from '../data-loader.ts';
import process from 'node:process';
import { createHeatmap } from '@ccusage/terminal/charts';
import {
	colors,
	getModelColor,
	getTrendIndicator,
	shortenModelName,
} from '@ccusage/terminal/colors';
import {
	createSparkline,
	formatCostCompact,
	formatTokensCompact,
} from '@ccusage/terminal/sparkline';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { groupByProject, groupDataByProject } from '../_daily-grouping.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { formatProjectName } from '../_project-names.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadDailyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Convert daily usage data to chart data entries.
 */
function toChartData(dailyData: DailyUsage[]): ChartDataEntry[] {
	return dailyData.map((d) => ({
		date: d.date,
		cost: d.totalCost,
		outputTokens: d.outputTokens,
		inputTokens: d.inputTokens,
		cacheReadTokens: d.cacheReadTokens,
	}));
}

/**
 * Build a model legend from all unique models in the data.
 */
function buildModelLegend(dailyData: DailyUsage[]): Map<string, number> {
	const allModels = new Set<string>();
	for (const day of dailyData) {
		for (const model of day.modelsUsed) {
			allModels.add(model);
		}
	}
	const legend = new Map<string, number>();
	let index = 0;
	for (const model of [...allModels].sort()) {
		legend.set(model, index++);
	}
	return legend;
}

/**
 * Get short 2-character model identifier like "op", "so", "ha".
 */
function getShortModelName(modelName: string): string {
	const nameLower = modelName.toLowerCase();
	if (nameLower.includes('opus')) {
		return 'op';
	}
	if (nameLower.includes('sonnet')) {
		return 'so';
	}
	if (nameLower.includes('haiku')) {
		return 'ha';
	}
	if (nameLower.includes('gpt')) {
		return 'gp';
	}
	// fallback: first 2 chars of first non-claude part
	const parts = nameLower.split('-').filter((p) => p !== 'claude');
	return (parts[0] ?? 'md').slice(0, 2);
}

/**
 * Format date as "Dec 08" style.
 */
function formatDateShort(dateStr: string): string {
	const date = new Date(`${dateStr}T12:00:00`);
	const month = date.toLocaleDateString('en-US', { month: 'short' });
	const day = String(date.getDate()).padStart(2, '0');
	return `${month} ${day}`;
}

/**
 * Calculate total tokens for a day.
 */
function getTotalTokensForDay(day: DailyUsage): number {
	return day.inputTokens + day.outputTokens + day.cacheCreationTokens + day.cacheReadTokens;
}

/**
 * Wrap legend entries to fit within maxWidth.
 */
function wrapLegend(entries: string[], maxWidth: number): string[] {
	const prefix = 'Legend: ';
	const lines: string[] = [];
	let currentLine = prefix;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] ?? '';
		const separator = i > 0 ? '   ' : '';
		const addition = separator + entry;

		// estimate visible width (strip ANSI codes for measurement)
		// eslint-disable-next-line no-control-regex
		const ansiPattern = /\x1B\[[0-9;]*m/g;
		const visibleWidth = currentLine.replace(ansiPattern, '').length;
		const additionWidth = addition.replace(ansiPattern, '').length;

		if (visibleWidth + additionWidth > maxWidth && currentLine !== prefix) {
			lines.push(currentLine);
			currentLine = `        ${entry}`; // indent continuation lines
		} else {
			currentLine += addition;
		}
	}
	if (currentLine.trim() !== '') {
		lines.push(currentLine);
	}
	return lines;
}

/**
 * Render the compact visual mode table with single-line rows.
 * Designed for visual clarity with proper column alignment and breathing room.
 */
function renderCompactVisual(
	dailyData: DailyUsage[],
	totals: ReturnType<typeof calculateTotals>,
): string {
	const overallAvg =
		dailyData.length > 0
			? dailyData.reduce((sum, d) => sum + d.totalCost, 0) / dailyData.length
			: 0;
	const legend = buildModelLegend(dailyData);

	const lines: string[] = [];

	// column widths for alignment (with breathing room)
	const COL = {
		date: 6, // "Dec 09"
		models: 9, // "op so ha" (3 models × 2 chars + spaces)
		input: 7,
		output: 7,
		cache: 7,
		total: 7,
		cost: 8,
		trend: 12,
	};

	// header with generous spacing
	const headerParts = [
		colors.text.accent('Date'.padEnd(COL.date)),
		colors.text.accent('Models'.padEnd(COL.models)),
		colors.text.accent('Input'.padStart(COL.input)),
		colors.text.accent('Output'.padStart(COL.output)),
		colors.text.accent('Cache'.padStart(COL.cache)),
		colors.text.accent('Total'.padStart(COL.total)),
		colors.text.accent('Cost'.padStart(COL.cost)),
		colors.text.accent('vs Avg'),
	];
	lines.push(headerParts.join('   ')); // 3-space gap between columns
	lines.push(colors.ui.border('\u2500'.repeat(82)));

	// data rows
	for (const day of dailyData) {
		const dateStr = formatDateShort(day.date);

		// models as short 2-char colored identifiers
		const modelStrs = day.modelsUsed.map((model) => {
			const index = legend.get(model) ?? 0;
			const color = getModelColor(index);
			return color(getShortModelName(model));
		});
		// join with space, pad to fixed width for alignment
		const modelsVisible = day.modelsUsed.map(getShortModelName).join(' ');
		const modelsPadding = COL.models - modelsVisible.length;
		const modelsStr = modelStrs.join(' ') + ' '.repeat(Math.max(0, modelsPadding));

		// compact token numbers - right aligned
		const inputStr = formatTokensCompact(day.inputTokens).padStart(COL.input);
		const outputStr = formatTokensCompact(day.outputTokens).padStart(COL.output);
		const cacheStr = formatTokensCompact(day.cacheReadTokens).padStart(COL.cache);
		const totalStr = formatTokensCompact(getTotalTokensForDay(day)).padStart(COL.total);
		// cost rounded to nearest dollar
		const costStr = `$${Math.round(day.totalCost)}`.padStart(COL.cost);

		// trend indicator with semantic color
		const deviation = overallAvg > 0 ? ((day.totalCost - overallAvg) / overallAvg) * 100 : 0;
		const trend = getTrendIndicator(deviation);
		const trendStr = trend.color(trend.indicator);

		const rowParts = [
			dateStr.padEnd(COL.date),
			modelsStr,
			inputStr,
			outputStr,
			cacheStr,
			totalStr,
			costStr,
			trendStr,
		];
		lines.push(rowParts.join('   '));
	}

	// totals row - use full cost amount for emphasis
	lines.push(colors.ui.border('\u2500'.repeat(82)));
	const totalTokens =
		totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
	const fullCostStr = `$${totals.totalCost.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
	const totalsRow = [
		colors.ui.totals('Total'.padEnd(COL.date)),
		' '.repeat(COL.models),
		colors.ui.totals(formatTokensCompact(totals.inputTokens).padStart(COL.input)),
		colors.ui.totals(formatTokensCompact(totals.outputTokens).padStart(COL.output)),
		colors.ui.totals(formatTokensCompact(totals.cacheReadTokens).padStart(COL.cache)),
		colors.ui.totals(formatTokensCompact(totalTokens).padStart(COL.total)),
		colors.ui.totals(fullCostStr.padStart(COL.cost)),
	];
	lines.push(totalsRow.join('   '));

	// model legend with wrapping
	lines.push('');
	const legendEntries: string[] = [];
	for (const [model, index] of legend) {
		const color = getModelColor(index);
		legendEntries.push(`${color(getShortModelName(model))}=${shortenModelName(model)}`);
	}
	const wrappedLegend = wrapLegend(legendEntries, 80);
	for (const line of wrappedLegend) {
		lines.push(colors.text.secondary(line));
	}

	return lines.join('\n');
}

/**
 * Render sparkline and heatmap footer.
 */
function renderVisualFooter(dailyData: DailyUsage[]): string {
	const chartData = toChartData(dailyData);
	const lines: string[] = [];

	// sparkline summary
	const costValues = dailyData.map((d) => d.totalCost);
	const sparkline = createSparkline(costValues, { width: Math.min(40, dailyData.length) });
	const minCost = Math.min(...costValues);
	const maxCost = Math.max(...costValues);
	const avgCost = costValues.reduce((a, b) => a + b, 0) / costValues.length;
	const totalCost = costValues.reduce((a, b) => a + b, 0);

	// format total cost as full amount (e.g., $6,200 instead of $6.2K)
	const fullTotalCostStr = `$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

	lines.push(colors.text.accent('Cost Trend'));
	lines.push(`${sparkline}  ${formatCostCompact(minCost)}\u2192${formatCostCompact(maxCost)}`);
	lines.push(
		colors.text.secondary(`avg ${formatCostCompact(avgCost)}/day  total ${fullTotalCostStr}`),
	);
	lines.push('');

	// heatmap
	const heatmap = createHeatmap(chartData, {
		title: 'Usage Heatmap (by cost)',
		metric: 'cost',
	});
	lines.push(heatmap);

	return lines.join('\n');
}

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
		projectAliases: {
			type: 'string',
			description:
				"Comma-separated project aliases (e.g., 'ccusage=Usage Tracker,myproject=My Project')",
			hidden: true,
		},
	},
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// Convert projectAliases to Map if it exists
		// Parse comma-separated key=value pairs
		let projectAliases: Map<string, string> | undefined;
		if (mergedOptions.projectAliases != null && typeof mergedOptions.projectAliases === 'string') {
			projectAliases = new Map();
			const pairs = mergedOptions.projectAliases
				.split(',')
				.map((pair) => pair.trim())
				.filter((pair) => pair !== '');
			for (const pair of pairs) {
				const parts = pair.split('=').map((s) => s.trim());
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

		const dailyData = await loadDailyUsageData({
			...mergedOptions,
			groupByProject: mergedOptions.instances,
		});

		if (dailyData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(dailyData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		if (useJson) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput =
				Boolean(mergedOptions.instances) && dailyData.some((d) => d.project != null)
					? {
							projects: groupByProject(dailyData),
							totals: createTotalsObject(totals),
						}
					: {
							daily: dailyData.map((data) => ({
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
			// Handle visual mode (-V or --visual)
			const useVisual = mergedOptions.visual === true || ctx.values.compact === true;

			if (useVisual) {
				// Print header
				logger.box('Claude Code Token Usage Report - Daily');

				// compact single-line rows with trend indicators + footer
				log(renderCompactVisual(dailyData, totals));
				log('');
				log(renderVisualFooter(dailyData));
				return;
			}

			// Print header for standard table mode
			logger.box('Claude Code Token Usage Report - Daily');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Date',
				dateFormatter: (dateStr: string) =>
					formatDateCompact(dateStr, mergedOptions.timezone, mergedOptions.locale ?? undefined),
				forceCompact: ctx.values.compact,
			};
			const table = createUsageReportTable(tableConfig);

			// Add daily data - group by project if instances flag is used
			if (Boolean(mergedOptions.instances) && dailyData.some((d) => d.project != null)) {
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
						pc.cyan(`Project: ${formatProjectName(projectName, projectAliases)}`),
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
						const row = formatUsageDataRow(data.date, {
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
						});
						table.push(row);

						// Add model breakdown rows if flag is set
						if (mergedOptions.breakdown) {
							pushBreakdownRows(table, data.modelBreakdowns);
						}
					}

					isFirstProject = false;
				}
			} else {
				// Standard display without project grouping
				for (const data of dailyData) {
					// Main row
					const row = formatUsageDataRow(data.date, {
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						modelsUsed: data.modelsUsed,
					});
					table.push(row);

					// Add model breakdown rows if flag is set
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
