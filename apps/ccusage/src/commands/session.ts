import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { loadSessionData } from '../adapter/claude/data-loader.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadConfig, mergeConfigWithArgs } from '../config-loader-tokens.ts';
import { formatDateCompact } from '../date-utils.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { logger, writeStdoutLine } from '../logger.ts';
import { sharedCommandConfig } from '../shared-args.ts';
import { createUsageLoadProgress, shouldShowUsageLoadProgress } from './loading-progress.ts';
import { handleSessionIdLookup } from './session_id.ts';

// eslint-disable-next-line ts/no-unused-vars
const { order: _, ...sharedArgs } = sharedCommandConfig.args;

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	args: {
		...sharedArgs,
		id: {
			type: 'string',
			short: 'i',
			description: 'Load usage data for a specific session ID',
		},
	},
	toKebab: true,
	async run(ctx): Promise<void> {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions: typeof ctx.values = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		const useJson = mergedOptions.json;
		const originalLoggerLevel = logger.level;
		if (useJson) {
			logger.level = 0;
		}

		// Handle specific session ID lookup
		if (mergedOptions.id != null) {
			return handleSessionIdLookup(
				{
					values: {
						id: mergedOptions.id,
						mode: mergedOptions.mode,
						offline: mergedOptions.offline,
						timezone: mergedOptions.timezone,
					},
				},
				useJson,
			);
		}

		// Original session listing logic
		const progress = createUsageLoadProgress(
			shouldShowUsageLoadProgress(mergedOptions, process.stdout),
		);
		let sessionData: Awaited<ReturnType<typeof loadSessionData>>;
		try {
			if (progress != null) {
				logger.level = 0;
			}
			progress?.start('claude');
			sessionData = await loadSessionData({
				since: mergedOptions.since,
				until: mergedOptions.until,
				mode: mergedOptions.mode,
				offline: mergedOptions.offline,
				singleThread: mergedOptions.singleThread,
				timezone: mergedOptions.timezone,
			});
			progress?.succeed('claude', sessionData.length);
		} catch (error) {
			progress?.fail('claude', error);
			throw error;
		} finally {
			progress?.stop();
			logger.level = originalLoggerLevel;
		}

		if (sessionData.length === 0) {
			if (useJson) {
				await writeStdoutLine(JSON.stringify([]));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map((data) => ({
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					projectPath: data.projectPath,
				})),
				totals: createTotalsObject(totals),
			};

			await writeStdoutLine(JSON.stringify(jsonOutput, null, 2));
		} else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Session',
				includeLastActivity: true,
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, ctx.values.timezone),
				forceCompact: ctx.values.compact,
			};
			const table = createUsageReportTable(tableConfig);

			// Add session data
			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				// Main row
				const row = formatUsageDataRow(
					sessionDisplay,
					{
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						modelsUsed: data.modelsUsed,
					},
					data.lastActivity,
				);
				table.push(row);

				// Add model breakdown rows if flag is set
				if (ctx.values.breakdown) {
					// Session has 1 extra column before data and 1 trailing column
					pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, 9);

			// Add totals
			const totalsRow = formatTotalsRow(
				{
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					cacheCreationTokens: totals.cacheCreationTokens,
					cacheReadTokens: totals.cacheReadTokens,
					totalCost: totals.totalCost,
				},
				true,
			); // Include Last Activity column
			table.push(totalsRow);

			const renderedTable = table.toString();

			await writeStdoutLine(renderedTable);

			if (table.isCompactMode()) {
				await writeStdoutLine();
				logger.info('Running in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});

// Note: Tests for --id functionality are covered by the existing loadSessionUsageById tests
// in data-loader.ts, since this command directly uses that function.
