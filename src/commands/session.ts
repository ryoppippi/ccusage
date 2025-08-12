import type { CostMode } from '../_types.ts';
import type { UsageData } from '../data-loader.ts';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, pushBreakdownRows, ResponsiveTable } from '../_utils.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { formatDateCompact, loadSessionData, loadSessionUsageById } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Calculates the total tokens for a session's entries
 */
function calculateSessionTotalTokens(entries: UsageData[]): number {
	return entries.reduce((sum, entry) => {
		const usage = entry.message.usage;
		return sum
			+ usage.input_tokens
			+ usage.output_tokens
			+ (usage.cache_creation_input_tokens ?? 0)
			+ (usage.cache_read_input_tokens ?? 0);
	}, 0);
}

/**
 * Handles session ID lookup and output formatting
 */
async function handleSessionIdLookup(
	ctx: { values: { id: string; mode: CostMode; offline: boolean; jq?: string; timezone?: string; locale?: string } },
	useJson: boolean,
): Promise<void> {
	const sessionUsage = await loadSessionUsageById(ctx.values.id, {
		mode: ctx.values.mode,
		offline: ctx.values.offline,
	});

	if (sessionUsage == null) {
		if (useJson) {
			log(JSON.stringify(null));
		}
		else {
			logger.warn(`No session found with ID: ${ctx.values.id}`);
		}
		process.exit(0);
	}

	if (useJson) {
		await outputSessionJsonFormat(ctx, sessionUsage);
	}
	else {
		await outputSessionTableFormat(ctx, sessionUsage);
	}
}

/**
 * Outputs session data in JSON format
 */
async function outputSessionJsonFormat(
	ctx: { values: { id: string; jq?: string } },
	sessionUsage: { totalCost: number; entries: UsageData[] },
): Promise<void> {
	const jsonOutput = {
		sessionId: ctx.values.id,
		totalCost: sessionUsage.totalCost,
		entries: sessionUsage.entries.map(entry => ({
			timestamp: entry.timestamp,
			inputTokens: entry.message.usage.input_tokens,
			outputTokens: entry.message.usage.output_tokens,
			cacheCreationTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
			cacheReadTokens: entry.message.usage.cache_read_input_tokens ?? 0,
			model: entry.message.model ?? 'unknown',
			costUSD: entry.costUSD ?? 0,
		})),
	};

	// Process with jq if specified
	if (ctx.values.jq != null) {
		const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
		if (Result.isFailure(jqResult)) {
			logger.error((jqResult.error).message);
			process.exit(1);
		}
		log(jqResult.value);
	}
	else {
		log(JSON.stringify(jsonOutput, null, 2));
	}
}

/**
 * Outputs session data in table format
 */
async function outputSessionTableFormat(
	ctx: { values: { id: string; timezone?: string; locale?: string } },
	sessionUsage: { totalCost: number; entries: UsageData[] },
): Promise<void> {
	// Print header
	logger.box(`Claude Code Session Usage - ${ctx.values.id}`);

	// Show session summary
	const totalTokens = calculateSessionTotalTokens(sessionUsage.entries);

	log(`Total Cost: ${formatCurrency(sessionUsage.totalCost)}`);
	log(`Total Tokens: ${formatNumber(totalTokens)}`);
	log(`Total Entries: ${sessionUsage.entries.length}`);
	log('');

	// Show individual entries
	if (sessionUsage.entries.length > 0) {
		const table = new ResponsiveTable({
			head: [
				'Timestamp',
				'Model',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Cost (USD)',
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
			],
		});

		for (const entry of sessionUsage.entries) {
			table.push([
				formatDateCompact(entry.timestamp, ctx.values.timezone, ctx.values.locale),
				entry.message.model ?? 'unknown',
				formatNumber(entry.message.usage.input_tokens),
				formatNumber(entry.message.usage.output_tokens),
				formatNumber(entry.message.usage.cache_creation_input_tokens ?? 0),
				formatNumber(entry.message.usage.cache_read_input_tokens ?? 0),
				formatCurrency(entry.costUSD ?? 0),
			]);
		}

		log(table.toString());
	}
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	args: {
		...sharedCommandConfig.args,
		id: {
			type: 'string',
			short: 'i',
			description: 'Load usage data for a specific session ID',
		},
	},
	toKebab: true,
	async run(ctx) {
		// --jq implies --json
		const useJson = ctx.values.json || ctx.values.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Handle specific session ID lookup
		if (ctx.values.id != null) {
			await handleSessionIdLookup(ctx, useJson);
			return;
		}

		// Original session listing logic
		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
		});

		if (sessionData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			}
			else {
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
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map(data => ({
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

			// Process with jq if specified
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error((jqResult.error).message);
					process.exit(1);
				}
				log(jqResult.value);
			}
			else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Session',
					'Models',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
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
					'left',
				],
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, ctx.values.timezone, ctx.values.locale),
				compactHead: [
					'Session',
					'Models',
					'Input',
					'Output',
					'Cost (USD)',
					'Last Activity',
				],
				compactColAligns: [
					'left',
					'left',
					'right',
					'right',
					'right',
					'left',
				],
				compactThreshold: 100,
			});

			// Add session data
			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				// Main row
				table.push([
					sessionDisplay,
					formatModelsDisplayMultiline(data.modelsUsed),
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.cacheCreationTokens),
					formatNumber(data.cacheReadTokens),
					formatNumber(getTotalTokens(data)),
					formatCurrency(data.totalCost),
					data.lastActivity,
				]);

				// Add model breakdown rows if flag is set
				if (ctx.values.breakdown) {
					// Session has 1 extra column before data and 1 trailing column
					pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
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
				'',
			]);

			// Add totals
			table.push([
				pc.yellow('Total'),
				'', // Empty for Models column in totals
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(totals))),
				pc.yellow(formatCurrency(totals.totalCost)),
				'',
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

// Note: Tests for --id functionality are covered by the existing loadSessionUsageById tests
// in data-loader.ts, since this command directly uses that function.
