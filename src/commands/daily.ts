import process from "node:process";
import Table from "cli-table3";
import { define } from "gunshi";
import pc from "picocolors";
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from "../calculate-cost.ts";
import { type LoadOptions, loadDailyUsageData } from "../data-loader.ts";
import { detectMismatches, printMismatchReport } from "../debug.ts";
import { log, logger } from "../logger.ts";
import { sharedCommandConfig } from "../shared-args.ts";
import { formatCurrency, formatNumber } from "../utils.ts";

export const dailyCommand = define({
	name: "daily",
	description: "Show usage report grouped by date",
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
			order: ctx.values.order,
		};
		const dailyData = await loadDailyUsageData(options);

		if (dailyData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			} else {
				logger.warn("No Claude usage data found.");
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(dailyData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(ctx.values.path);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				daily: dailyData.map((data) => ({
					date: data.date,
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
			logger.box("Claude Code Token Usage Report - Daily");

			// Create table
			const table = new Table({
				head: [
					"Date",
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

			// Add daily data
			for (const data of dailyData) {
				table.push([
					data.date,
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
