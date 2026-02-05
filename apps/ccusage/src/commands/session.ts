import type { UsageReportConfig } from '@ccusage/terminal/table';
import type { SessionUsage } from '../data-loader.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_LOCALE } from '../_consts.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadSessionData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';
import { handleSessionIdLookup } from './_session_id.ts';

// eslint-disable-next-line ts/no-unused-vars
const { order: _, ...sharedArgs } = sharedCommandConfig.args;

type SessionJsonOutput = {
	sessions: Array<{
		sessionId: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		totalTokens: number;
		totalCost: number;
		lastActivity: string;
		modelsUsed: string[];
		modelBreakdowns: SessionUsage['modelBreakdowns'];
		projectPath: string;
	}>;
	totals: ReturnType<typeof createTotalsObject>;
};

/**
 * Build the JSON output payload for session usage reports.
 */
function buildSessionJsonOutput(
	sessionData: SessionUsage[],
	totals: Parameters<typeof createTotalsObject>[0],
): SessionJsonOutput {
	return {
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
}

/**
 * Render session usage JSON output, applying jq when requested.
 */
async function renderSessionJsonOutput(
	sessionData: SessionUsage[],
	totals: Parameters<typeof createTotalsObject>[0],
	jq: string | null | undefined,
): Result.ResultAsync<string, Error> {
	const jsonOutput = buildSessionJsonOutput(sessionData, totals);

	if (jq != null) {
		return processWithJq(jsonOutput, jq);
	}

	return Result.succeed(JSON.stringify(jsonOutput, null, 2));
}

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

		// --jq implies --json
		const useJson = mergedOptions.json || mergedOptions.jq != null;
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
						jq: mergedOptions.jq,
						timezone: mergedOptions.timezone,
						locale: mergedOptions.locale ?? DEFAULT_LOCALE,
					},
				},
				useJson,
			);
		}

		// Original session listing logic
		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			offline: ctx.values.offline,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
		});

		if (sessionData.length === 0) {
			if (useJson) {
				const totals = {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				};
				const jsonResult = await renderSessionJsonOutput([], totals, mergedOptions.jq);
				if (Result.isFailure(jsonResult)) {
					logger.error(jsonResult.error.message);
					process.exit(1);
				}
				log(jsonResult.value);
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (ctx.values.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (useJson) {
			const jsonResult = await renderSessionJsonOutput(sessionData, totals, mergedOptions.jq);
			if (Result.isFailure(jsonResult)) {
				logger.error(jsonResult.error.message);
				process.exit(1);
			}
			log(jsonResult.value);
		} else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Session',
				includeLastActivity: true,
				dateFormatter: (dateStr: string) =>
					formatDateCompact(dateStr, ctx.values.timezone, ctx.values.locale),
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

			log(table.toString());

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});

if (import.meta.vitest != null) {
	describe('renderSessionJsonOutput', () => {
		it('applies jq to empty session payloads', async () => {
			const result = await renderSessionJsonOutput(
				[],
				{
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
				'.totals.totalTokens',
			);

			const output = Result.unwrap(result);
			expect(output).toBe('0');
		});
	});
}

// Note: Tests for --id functionality are covered by the existing loadSessionUsageById tests
// in data-loader.ts, since this command directly uses that function.
