import process from "node:process";
import Table from "cli-table3";
import { define } from "gunshi";
import pc from "picocolors";
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from "../calculate-cost.ts";
import { type LoadOptions, loadSessionData } from "../data-loader.ts";
import { log, logger } from "../logger.ts";
import { sharedArgs } from "../shared-args.ts";
import type { CostMode } from "../types.ts";
import { formatCurrency, formatNumber } from "../utils.ts";

export const sessionCommand = define({
	name: "session",
	description: "Show usage report grouped by conversation session",
	args: sharedArgs,
	async run(ctx) {
		const options: LoadOptions = {
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
			mode: ctx.values.mode as CostMode,
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
		const totals = calculateTotals(sessionData);

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map((data) => ({
					projectPath: data.projectPath,
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
				})),
				totals: createTotalsObject(totals),
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
					"Input",
					"Output",
					"Cache Create",
					"Cache Read",
					"Total Tokens",
					"Cost (USD)",
					"Last Activity",
				],
				style: {
					head: ["cyan"],
				},
				colAligns: [
					"left",
					"left",
					"right",
					"right",
					"right",
					"right",
					"right",
					"right",
					"left",
				],
			});

			let maxProjectLength = 0;
			let maxSessionLength = 0;
			for (const data of sessionData) {
				const projectDisplay =
					data.projectPath.length > 20
						? `...${data.projectPath.slice(-17)}`
						: data.projectPath;
				const sessionDisplay = data.sessionId.split("-").slice(-2).join("-"); // Display last two parts of session ID

				maxProjectLength = Math.max(maxProjectLength, projectDisplay.length);
				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				table.push([
					projectDisplay,
					sessionDisplay,
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.cacheCreationTokens),
					formatNumber(data.cacheReadTokens),
					formatNumber(getTotalTokens(data)),
					formatCurrency(data.totalCost),
					data.lastActivity,
				]);
			}

			// Add separator
			table.push([
				"─".repeat(maxProjectLength), // For Project
				"─".repeat(maxSessionLength), // For Session
				"─".repeat(12), // For Input Tokens
				"─".repeat(12), // For Output Tokens
				"─".repeat(12), // For Cache Create
				"─".repeat(12), // For Cache Read
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
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(totals))),
				pc.yellow(formatCurrency(totals.totalCost)),
				"",
			]);

			// biome-ignore lint/suspicious/noConsole: <explanation>
			console.log(table.toString());
		}
	},
});
