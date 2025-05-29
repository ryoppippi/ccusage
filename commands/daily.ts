import Table from "cli-table3";
import { define } from "gunshi";
import pc from "picocolors";
import { type LoadOptions, loadUsageData } from "../data-loader.ts";
import { logger } from "../logger.ts";
import { formatCurrency, formatNumber } from "../utils.ts";

export const dailyCommand = define({
	name: "daily",
	description: "Show usage report grouped by date",
	args: {
		since: {
			type: "string",
			short: "s",
			description: "Filter from date (YYYYMMDD format)",
		},
		until: {
			type: "string",
			short: "u",
			description: "Filter until date (YYYYMMDD format)",
		},
		path: {
			type: "string",
			short: "p",
			description: "Custom path to Claude data directory (default: ~/.claude)",
		},
	},
	async run(ctx) {
		const options: LoadOptions = {
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
		};
		const dailyData = await loadUsageData(options);

		if (dailyData.length === 0) {
			logger.warn("No Claude usage data found.");
			process.exit(0);
		}

		// Calculate totals
		const totals = dailyData.reduce(
			(acc, data) => ({
				inputTokens: acc.inputTokens + data.inputTokens,
				outputTokens: acc.outputTokens + data.outputTokens,
				totalCost: acc.totalCost + data.totalCost,
			}),
			{ inputTokens: 0, outputTokens: 0, totalCost: 0 },
		);

		// Print header
		logger.box("Claude Code Token Usage Report - Daily");

		// Create table
		const table = new Table({
			head: [
				"Date",
				"Input Tokens",
				"Output Tokens",
				"Total Tokens",
				"Cost (USD)",
			],
			style: {
				head: ["cyan"],
			},
			colAligns: ["left", "right", "right", "right", "right"],
		});

		// Add daily data
		for (const data of dailyData) {
			table.push([
				data.date,
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.inputTokens + data.outputTokens),
				formatCurrency(data.totalCost),
			]);
		}

		// Add separator
		table.push([
			"─".repeat(16),
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
			pc.yellow(formatNumber(totals.inputTokens + totals.outputTokens)),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		// biome-ignore lint/suspicious/noConsole: <explanation>
		console.log(table.toString());
	},
});
