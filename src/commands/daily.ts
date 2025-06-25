import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, pushBreakdownRows, ResponsiveTable } from '../_utils.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { CurrencyConverter } from '../currency-converter.ts';
import { validateCurrency } from '../currency-validator.ts';
import { formatDateCompact, loadDailyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show usage report grouped by date',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const dailyData = await loadDailyUsageData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
		});

		if (dailyData.length === 0) {
			if (ctx.values.json) {
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
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		// Set up currency conversion
		using currencyConverter = new CurrencyConverter();

		// Validate and normalize currency
		let targetCurrency: string;
		try {
			targetCurrency = await validateCurrency(ctx.values.currency, currencyConverter);
		}
		catch {
			process.exit(1);
		}

		// Convert costs for daily data
		const convertedDailyData = await Promise.all(dailyData.map(async (data) => {
			const convertedCost = await currencyConverter.convertAmount(data.totalCost, targetCurrency);
			const convertedBreakdowns = await Promise.all(data.modelBreakdowns.map(async (breakdown) => {
				const convertedBreakdownCost = await currencyConverter.convertAmount(breakdown.cost, targetCurrency);
				return {
					...breakdown,
					cost: convertedBreakdownCost ?? breakdown.cost, // Fallback to original USD
				};
			}));

			return {
				...data,
				totalCost: convertedCost ?? data.totalCost, // Fallback to original USD
				modelBreakdowns: convertedBreakdowns,
			};
		}));

		// Convert totals
		const convertedTotalCost = await currencyConverter.convertAmount(totals.totalCost, targetCurrency);
		const convertedTotals = {
			...totals,
			totalCost: convertedTotalCost ?? totals.totalCost, // Fallback to original USD
		};

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				currency: targetCurrency,
				daily: convertedDailyData.map(data => ({
					date: data.date,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				})),
				totals: createTotalsObject(convertedTotals),
			};
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - Daily');

			// Get currency column header
			const currencyColumnHeader = currencyConverter.getCurrencyColumnHeader(targetCurrency);

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
					currencyColumnHeader,
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
					'Date',
					'Models',
					'Input',
					'Output',
					currencyColumnHeader,
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

			// Add daily data
			for (const data of convertedDailyData) {
				// Main row
				table.push([
					data.date,
					formatModelsDisplayMultiline(data.modelsUsed),
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.cacheCreationTokens),
					formatNumber(data.cacheReadTokens),
					formatNumber(getTotalTokens(data)),
					formatCurrency(data.totalCost, targetCurrency),
				]);

				// Add model breakdown rows if flag is set
				if (ctx.values.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns, 1, 0, targetCurrency);
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
				pc.yellow(formatNumber(convertedTotals.inputTokens)),
				pc.yellow(formatNumber(convertedTotals.outputTokens)),
				pc.yellow(formatNumber(convertedTotals.cacheCreationTokens)),
				pc.yellow(formatNumber(convertedTotals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(convertedTotals))),
				pc.yellow(formatCurrency(convertedTotals.totalCost, targetCurrency)),
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
