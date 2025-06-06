import process from "node:process";
import Table from "cli-table3";
import { define } from "gunshi";
import pc from "picocolors";
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from "../calculate-cost.ts";
import { type LoadOptions, loadUsageData } from "../data-loader.ts";
import type { DailyUsage } from "../data-loader.ts";
import { detectMismatches, printMismatchReport } from "../debug.ts";
import { log, logger } from "../logger.ts";
import { sharedCommandConfig } from "../shared-args.ts";
import { formatCurrency, formatNumber } from "../utils.ts";

interface MonthlyUsage {
	month: string; // YYYY-MM format
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
}

const aggregateByMonth = (dailyData: DailyUsage[]): MonthlyUsage[] => {
	const monthlyMap = new Map<string, MonthlyUsage>();

	for (const data of dailyData) {
		// Extract YYYY-MM from YYYY-MM-DD
		const month = data.date.substring(0, 7);

		const existing = monthlyMap.get(month) || {
			month,
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		};

		existing.inputTokens += data.inputTokens;
		existing.outputTokens += data.outputTokens;
		existing.cacheCreationTokens += data.cacheCreationTokens;
		existing.cacheReadTokens += data.cacheReadTokens;
		existing.totalCost += data.totalCost;

		monthlyMap.set(month, existing);
	}

	// Convert to array and sort by month descending
	return Array.from(monthlyMap.values()).sort((a, b) =>
		b.month.localeCompare(a.month),
	);
};

export const monthlyCommand = define({
	name: "monthly",
	description: "Show usage report grouped by month",
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const options: LoadOptions = {
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
			mode: ctx.values.mode,
		};
		const dailyData = await loadUsageData(options);

		if (dailyData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			} else {
				logger.warn("No Claude usage data found.");
			}
			process.exit(0);
		}

		// Aggregate daily data by month
		const monthlyData = aggregateByMonth(dailyData);

		// Calculate totals
		const totals = monthlyData.reduce(
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
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(ctx.values.path);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
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
				})),
				totals: createTotalsObject(totals),
			};
			log(JSON.stringify(jsonOutput, null, 2));
		} else {
			// Print header
			logger.box("Claude Code Token Usage Report - Monthly");

			// Create table
			const table = new Table({
				head: [
					"Month",
					"Input",
					"Output",
					"Cache Create",
					"Cache Read",
					"Total Tokens",
					"Cost (USD)",
				],
				style: {
					head: ["cyan"],
				},
				colAligns: [
					"left",
					"right",
					"right",
					"right",
					"right",
					"right",
					"right",
				],
			});

			// Add monthly data
			for (const data of monthlyData) {
				table.push([
					data.month,
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.cacheCreationTokens),
					formatNumber(data.cacheReadTokens),
					formatNumber(getTotalTokens(data)),
					formatCurrency(data.totalCost),
				]);
			}

			// Add separator
			table.push([
				"─".repeat(12),
				"─".repeat(12),
				"─".repeat(12),
				"─".repeat(12),
				"─".repeat(12),
				"─".repeat(12),
				"─".repeat(10),
			]);

			// Add totals
			table.push([
				pc.yellow("Total"),
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(totals))),
				pc.yellow(formatCurrency(totals.totalCost)),
			]);

			log(table.toString());
		}
	},
});
