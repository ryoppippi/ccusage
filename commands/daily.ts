import process from "node:process";
import Table from "cli-table3";
import { define } from "gunshi";
import pc from "picocolors";
import { type LoadOptions, loadUsageData } from "../data-loader.ts";
import { log, logger } from "../logger.ts";
import { sharedArgs } from "../shared-args.ts";
import { formatCurrency, formatNumber } from "../utils.ts";

export const dailyCommand = define({
	name: "daily",
	description: "Show usage report grouped by date",
	args: sharedArgs,
	async run(ctx) {
		const options: LoadOptions = {
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
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

		// Calculate totals
		const totals = dailyData.reduce(
			(acc, data) => ({
				inputTokens: acc.inputTokens + data.inputTokens,
				outputTokens: acc.outputTokens + data.outputTokens,
				cacheCreationTokens: acc.cacheCreationTokens + data.cacheCreationTokens,
				cacheReadTokens: acc.cacheReadTokens + data.cacheReadTokens,
				totalCost: acc.totalCost + data.totalCost,
			}),
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
			},
		);

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				daily: dailyData.map((data) => ({
					date: data.date,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens:
						data.inputTokens +
						data.outputTokens +
						data.cacheCreationTokens +
						data.cacheReadTokens,
					totalCost: data.totalCost,
				})),
				totals: {
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					cacheCreationTokens: totals.cacheCreationTokens,
					cacheReadTokens: totals.cacheReadTokens,
					totalTokens:
						totals.inputTokens +
						totals.outputTokens +
						totals.cacheCreationTokens +
						totals.cacheReadTokens,
					totalCost: totals.totalCost,
				},
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
					formatNumber(
						data.inputTokens +
							data.outputTokens +
							data.cacheCreationTokens +
							data.cacheReadTokens,
					),
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
				pc.yellow(
					formatNumber(
						totals.inputTokens +
							totals.outputTokens +
							totals.cacheCreationTokens +
							totals.cacheReadTokens,
					),
				),
				pc.yellow(formatCurrency(totals.totalCost)),
			]);

			// biome-ignore lint/suspicious/noConsole: <explanation>
			console.log(table.toString());
		}
	},
});
