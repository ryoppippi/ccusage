import process from "node:process";
import Table from "cli-table3";
import { define } from "gunshi";
import pc from "picocolors";
import { type LoadOptions, loadSessionData } from "../data-loader.ts";
import { log, logger } from "../logger.ts";
import { formatCurrency, formatNumber } from "../utils.ts";

export const sessionCommand = define({
	name: "session",
	description: "Show usage report grouped by conversation session",
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
		json: {
			type: "boolean",
			short: "j",
			description: "Output in JSON format",
		},
	},
	async run(ctx) {
		const options: LoadOptions = {
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
		};
		const sessionData = await loadSessionData(options);

		if (sessionData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			} else {
				logger.warn("No Claude usage data found.");
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = sessionData.reduce(
			(acc, data) => ({
				inputTokens: acc.inputTokens + data.inputTokens,
				outputTokens: acc.outputTokens + data.outputTokens,
				totalCost: acc.totalCost + data.totalCost,
			}),
			{ inputTokens: 0, outputTokens: 0, totalCost: 0 },
		);

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map((data) => ({
					projectPath: data.projectPath,
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					totalTokens: data.inputTokens + data.outputTokens,
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
				})),
				totals: {
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					totalTokens: totals.inputTokens + totals.outputTokens,
					totalCost: totals.totalCost,
				},
			};
			log(JSON.stringify(jsonOutput, null, 2));
		} else {
			// Print header
			logger.box("Claude Code Token Usage Report - By Session");

			// Create table
			const table = new Table({
				head: [
					"Project",
					"Session",
					"Input Tokens",
					"Output Tokens",
					"Total Tokens",
					"Cost (USD)",
					"Last Activity",
				],
				style: {
					head: ["cyan"],
				},
				colAligns: ["left", "left", "right", "right", "right", "right", "left"],
			});

			// Add session data
			for (const data of sessionData) {
				const projectDisplay =
					data.projectPath.length > 20
						? `...${data.projectPath.slice(-17)}`
						: data.projectPath;
				const sessionDisplay =
					data.sessionId.length > 30
						? `...${data.sessionId.slice(-27)}`
						: data.sessionId;

				table.push([
					projectDisplay,
					sessionDisplay,
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.inputTokens + data.outputTokens),
					formatCurrency(data.totalCost),
					data.lastActivity,
				]);
			}

			// Add separator
			table.push([
				"─".repeat(20), // For Project
				"─".repeat(30), // For Session
				"─".repeat(12), // For Input Tokens
				"─".repeat(12), // For Output Tokens
				"─".repeat(12), // For Total Tokens
				"─".repeat(10), // For Cost
				"─".repeat(12), // For Last Activity
			]);

			// Add totals
			table.push([
				pc.yellow("Total"),
				"", // Empty for Session column in totals
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.inputTokens + totals.outputTokens)),
				pc.yellow(formatCurrency(totals.totalCost)),
				"",
			]);

			// biome-ignore lint/suspicious/noConsole: <explanation>
			console.log(table.toString());
		}
	},
});
