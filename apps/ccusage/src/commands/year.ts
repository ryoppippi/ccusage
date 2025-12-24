/**
 * Year/Wrapped command - Generate annual usage report
 */

import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { define } from 'gunshi';
import { buildYearReport } from '../_year-report.ts';
import { formatYearTerminal, generateYearHTML } from '../_year-formatters.ts';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { loadDailyUsageData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export const yearCommand = define({
	name: 'year',
	description: 'Generate an annual usage report (Year Wrapped)',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		year: {
			type: 'number',
			short: 'y',
			description: 'Year to analyze (default: current year)',
		},
		format: {
			type: 'enum',
			short: 'f',
			description: 'Output format',
			default: 'terminal' as const,
			choices: ['terminal', 'json', 'html'] as const,
		},
		output: {
			type: 'string',
			short: 'o',
			description: 'Output file path (for html/json formats)',
		},
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Include project breakdown in report',
			default: true,
		},
	},
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		const format = ctx.values.format ?? 'terminal';
		const outputPath = ctx.values.output;
		const targetYear = ctx.values.year ?? new Date().getFullYear();

		// If JSON output, suppress logs
		const useJson = format === 'json';
		if (useJson) {
			logger.level = 0;
		}

		// Load daily data with project grouping
		const dailyData = await loadDailyUsageData({
			...mergedOptions,
			groupByProject: ctx.values.instances ?? true,
		});

		if (dailyData.length === 0) {
			const emptyOutput = useJson
				? JSON.stringify({ year: targetYear, stats: null }, null, 2)
				: `No Claude usage data found for ${targetYear}.`;
			log(emptyOutput);
			process.exit(0);
		}

		// Build year report
		const stats = buildYearReport(dailyData, targetYear);

		if (stats == null) {
			const noDataOutput = useJson
				? JSON.stringify({ year: targetYear, stats: null }, null, 2)
				: `No Claude usage data found for ${targetYear}.`;
			log(noDataOutput);
			process.exit(0);
		}

		// Generate output based on format
		switch (format) {
			case 'json': {
				// Convert Map to array for JSON serialization
				const jsonStats = {
					...stats,
					dailyActivity: Array.from(stats.dailyActivity.values()),
				};
				const jsonOutput = JSON.stringify({ year: targetYear, stats: jsonStats }, null, 2);
				if (outputPath) {
					await writeFile(outputPath, jsonOutput, 'utf-8');
					logger.success(`Report saved to ${outputPath}`);
				}
				else {
					log(jsonOutput);
				}
				break;
			}

			case 'html': {
				const htmlOutput = generateYearHTML(stats);
				if (outputPath) {
					await writeFile(outputPath, htmlOutput, 'utf-8');
					logger.success(`HTML report saved to ${outputPath}`);
					logger.info(`Open ${outputPath} in your browser to view the report`);
				}
				else {
					// Default filename
					const defaultPath = `${targetYear}-claude-code-wrapped.html`;
					await writeFile(defaultPath, htmlOutput, 'utf-8');
					logger.success(`HTML report saved to ${defaultPath}`);
					logger.info(`Open ${defaultPath} in your browser to view the report`);
				}
				break;
			}

			case 'terminal':
			default: {
				const terminalOutput = formatYearTerminal(stats);
				log(terminalOutput);
				break;
			}
		}
	},
});

// Alias: wrapped
export const wrappedCommand = define({
	...yearCommand,
	name: 'wrapped',
	description: 'Alias for "year" command - Generate your Claude Code Wrapped report',
});
