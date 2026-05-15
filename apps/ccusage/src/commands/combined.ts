import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	pushBreakdownRows,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
	loadCombinedDailyUsage,
	parseCombinedOriginsArg,
	setCombinedOriginLoggerLevel,
} from '../_combined-usage.ts';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { processWithJq } from '../_jq-processor.ts';
import { formatProjectName } from '../_project-names.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { log, logger } from '../logger.ts';

type CombinedJsonRow = {
	date: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	originsUsed: string[];
	originBreakdowns: Record<string, unknown>;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
	project?: string;
};

function formatOriginCosts(
	row: Awaited<ReturnType<typeof loadCombinedDailyUsage>>[number],
): string {
	return row.originsUsed
		.map((origin) => {
			const breakdown = row.originBreakdowns[origin];
			return formatCurrency(breakdown?.totalCost ?? 0);
		})
		.join('\n');
}

function formatOriginMetric(
	row: Awaited<ReturnType<typeof loadCombinedDailyUsage>>[number],
	metric:
		| 'inputTokens'
		| 'outputTokens'
		| 'cacheCreationTokens'
		| 'cacheReadTokens'
		| 'totalTokens',
): string {
	return row.originsUsed
		.map((origin) => {
			const breakdown = row.originBreakdowns[origin];
			return formatNumber(breakdown?.[metric] ?? 0);
		})
		.join('\n');
}

function calculateCombinedTotals(
	data: Array<{
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		totalCost: number;
	}>,
): {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
} {
	return data.reduce(
		(acc, item) => {
			acc.inputTokens += item.inputTokens;
			acc.outputTokens += item.outputTokens;
			acc.cacheCreationTokens += item.cacheCreationTokens;
			acc.cacheReadTokens += item.cacheReadTokens;
			acc.totalCost += item.totalCost;
			return acc;
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		},
	);
}

function groupCombinedRowsByProject<T extends { project?: string }>(
	rows: T[],
): Record<string, T[]> {
	const projects: Record<string, T[]> = {};

	for (const row of rows) {
		const projectName = row.project ?? 'unknown';
		if (projects[projectName] == null) {
			projects[projectName] = [];
		}
		projects[projectName].push(row);
	}

	return projects;
}

function toJsonRows(rows: Awaited<ReturnType<typeof loadCombinedDailyUsage>>): CombinedJsonRow[] {
	return rows.map((row) => ({
		date: row.date,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		cacheReadTokens: row.cacheReadTokens,
		totalTokens: getTotalTokens(row),
		totalCost: row.totalCost,
		originsUsed: row.originsUsed,
		originBreakdowns: row.originBreakdowns,
		modelsUsed: row.modelsUsed,
		modelBreakdowns: row.modelBreakdowns,
		...(row.project != null && { project: row.project }),
	}));
}

export const combinedCommand = define({
	name: 'combined',
	description: 'Show usage report combined across multiple origins and grouped by date',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Show usage breakdown by project/directory',
			default: false,
		},
		project: {
			type: 'string',
			short: 'p',
			description: 'Filter to specific project/directory',
		},
		projectAliases: {
			type: 'string',
			description:
				"Comma-separated project aliases (e.g., 'ccusage=Usage Tracker,myproject=My Project')",
			hidden: true,
		},
		origins: {
			type: 'string',
			description:
				"Comma-separated origins to include (default: claude,codex,kimi,opencode). Use 'all' to include amp and pi too.",
		},
	},
	async run(ctx) {
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		let projectAliases: Map<string, string> | undefined;
		if (mergedOptions.projectAliases != null && typeof mergedOptions.projectAliases === 'string') {
			projectAliases = new Map();
			const pairs = mergedOptions.projectAliases
				.split(',')
				.map((pair) => pair.trim())
				.filter((pair) => pair !== '');

			for (const pair of pairs) {
				const parts = pair.split('=').map((value) => value.trim());
				const rawName = parts[0];
				const alias = parts[1];
				if (rawName != null && alias != null && rawName !== '' && alias !== '') {
					projectAliases.set(rawName, alias);
				}
			}
		}

		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
			setCombinedOriginLoggerLevel(0);
		}

		let origins;
		try {
			origins = parseCombinedOriginsArg(
				typeof mergedOptions.origins === 'string' ? mergedOptions.origins : undefined,
			);
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const combinedRows = await loadCombinedDailyUsage({
			mode: mergedOptions.mode,
			offline: mergedOptions.offline,
			order: mergedOptions.order,
			groupByProject: mergedOptions.instances,
			origins,
			project: mergedOptions.project,
			since: mergedOptions.since,
			timezone: mergedOptions.timezone,
			until: mergedOptions.until,
		});

		if (combinedRows.length === 0) {
			if (useJson) {
				log(
					JSON.stringify({
						origins,
						daily: [],
						totals: createTotalsObject(calculateCombinedTotals([])),
					}),
				);
			} else {
				logger.warn('No usage data found for the selected origins.');
			}
			process.exit(0);
		}

		const totals = calculateCombinedTotals(combinedRows);

		if (useJson) {
			const jsonRows = toJsonRows(combinedRows);
			const jsonOutput =
				Boolean(mergedOptions.instances) && combinedRows.some((row) => row.project != null)
					? {
							origins,
							projects: groupCombinedRowsByProject(jsonRows),
							totals: createTotalsObject(totals),
						}
					: {
							origins,
							daily: jsonRows,
							totals: createTotalsObject(totals),
						};

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
			return;
		}

		logger.box('Combined Usage Report - Daily');

		const table = new ResponsiveTable({
			head: [
				'Date',
				'Origins',
				'Origin Cost',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Date', 'Origins', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 110,
			forceCompact: ctx.values.compact,
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr, mergedOptions.timezone),
		});

		const renderRow = (row: Awaited<ReturnType<typeof loadCombinedDailyUsage>>[number]): void => {
			table.push([
				row.date,
				formatModelsDisplayMultiline(row.originsUsed),
				formatOriginCosts(row),
				formatOriginMetric(row, 'inputTokens'),
				formatOriginMetric(row, 'outputTokens'),
				formatOriginMetric(row, 'cacheCreationTokens'),
				formatOriginMetric(row, 'cacheReadTokens'),
				formatOriginMetric(row, 'totalTokens'),
				formatCurrency(row.totalCost),
			]);

			if (mergedOptions.breakdown) {
				pushBreakdownRows(table, row.modelBreakdowns, 1, 0);
			}
		};

		if (Boolean(mergedOptions.instances) && combinedRows.some((row) => row.project != null)) {
			const projectGroups = groupCombinedRowsByProject(combinedRows);
			let isFirstProject = true;

			for (const [projectName, projectRows] of Object.entries(projectGroups)) {
				if (!isFirstProject) {
					table.push(['', '', '', '', '', '', '', '', '']);
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
					'',
				]);

				for (const row of projectRows) {
					renderRow(row);
				}

				isFirstProject = false;
			}
		} else {
			for (const row of combinedRows) {
				renderRow(row);
			}
		}

		addEmptySeparatorRow(table, 9);
		table.push([
			pc.yellow('Total'),
			'',
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheCreationTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(getTotalTokens(totals))),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		log(table.toString());

		if (table.isCompactMode()) {
			logger.info('\nRunning in Compact Mode');
			logger.info(
				'Expand terminal width to see origins, origin costs, cache metrics, and total tokens',
			);
		}
	},
});
