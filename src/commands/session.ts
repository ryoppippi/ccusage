import type { CostMode } from '../types.internal.ts';
import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import {
	calculateWindowStatistics,
	formatDateCompact,
	getDefaultClaudePath,
	groupWindowsByMonth,
	loadSessionData,
	type SessionUsage,
	type UsageData,
} from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import {
	formatCurrency,
	formatDuration,
	formatModelsDisplay,
	formatNumber,
	getWindowStartTime,
	pushBreakdownRows,
} from '../utils.internal.ts';
import { ResponsiveTable } from '../utils.table.ts';

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		windows: {
			type: 'boolean',
			short: 'w',
			description: 'Show 5-hour session window statistics',
			default: false,
		},
		sessionLimit: {
			type: 'number',
			short: 'l',
			description: 'Session limit for your plan (e.g., 50 for Max plan)',
			default: 50,
		},
	},
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: getDefaultClaudePath(),
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
		});

		if (sessionData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Check if windows mode is requested
		if (ctx.values.windows) {
			// Window statistics mode
			await displayWindowStatistics(sessionData, ctx.values);
			return;
		}

		// Regular session mode continues below
		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(getDefaultClaudePath());
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
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
				})),
				totals: createTotalsObject(totals),
			};
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table
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
				dateFormatter: formatDateCompact,
			});

			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				// Main row
				table.push([
					sessionDisplay,
					formatModelsDisplay(data.modelsUsed),
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
		}
	},
});

/**
 * Display 5-hour window statistics
 */
async function displayWindowStatistics(
	sessionData: SessionUsage[],
	options: {
		json?: boolean;
		sessionLimit?: number;
		order?: string;
		mode?: string;
		since?: string;
		until?: string;
		debug?: boolean;
		debugSamples?: number;
	},
): Promise<void> {
	// Extract all entries from session data to calculate windows
	// We need to reconstruct the raw entries since sessionData is already aggregated
	// For now, we'll load the data again with raw entries
	const allEntries: Array<{
		data: UsageData;
		timestamp: string;
		cost: number;
		sessionKey: string;
		model: string | undefined;
	}> = [];

	// Load raw data to get all entries
	// This is a temporary solution - ideally we'd refactor loadSessionData to return raw entries
	const claudePath = getDefaultClaudePath();
	const path = await import('node:path');
	const claudeDir = path.join(claudePath, 'projects');
	const { glob } = await import('tinyglobby');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	// Load and parse all entries
	const { readFile } = await import('node:fs/promises');
	const v = await import('valibot');
	const { PricingFetcher } = await import('../pricing-fetcher.ts');
	const { UsageDataSchema, calculateCostForEntry } = await import('../data-loader.ts');

	const mode = options.mode ?? 'auto';
	using fetcher = mode === 'display' ? null : new PricingFetcher();

	for (const file of files) {
		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		// Extract session info from file path
		const relativePath = path.relative(claudeDir, file);
		const parts = relativePath.split(path.sep);
		const sessionId = parts[parts.length - 2] ?? 'unknown';
		const joinedPath = parts.slice(0, -2).join(path.sep);
		const projectPath = joinedPath.length > 0 ? joinedPath : 'Unknown Project';
		const sessionKey = `${projectPath}/${sessionId}`;

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				const cost = fetcher != null
					? await calculateCostForEntry(data, mode as CostMode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({
					data,
					timestamp: data.timestamp,
					cost,
					sessionKey,
					model: data.message.model,
				});
			}
			catch {
				// Skip invalid lines
			}
		}
	}

	// Calculate window statistics
	const windowMap = calculateWindowStatistics(allEntries);
	const monthlySummaries = groupWindowsByMonth(windowMap, {
		sessionLimit: options.sessionLimit,
	});

	// Filter by date range if specified
	const filteredSummaries = monthlySummaries.filter((summary) => {
		if ((options.since !== undefined && options.since !== '') || (options.until !== undefined && options.until !== '')) {
			const monthNum = summary.month.replace('-', '');
			if (options.since !== undefined && options.since !== '' && monthNum < options.since.substring(0, 6)) {
				return false;
			}
			if (options.until !== undefined && options.until !== '' && monthNum > options.until.substring(0, 6)) {
				return false;
			}
		}
		return true;
	});

	if (options.json === true) {
		// JSON output
		const jsonOutput = {
			monthlySummaries: filteredSummaries.map(summary => ({
				month: summary.month,
				windowCount: summary.windowCount,
				sessionLimit: summary.sessionLimit,
				remainingSessions: summary.remainingSessions,
				utilizationPercent: summary.utilizationPercent,
				totalCost: summary.totalCost,
				totalTokens: summary.totalTokens,
				windows: summary.windows.map(window => ({
					windowId: window.windowId,
					startTime: window.startTimestamp,
					endTime: window.endTimestamp,
					duration: window.duration,
					messageCount: window.messageCount,
					sessionCount: window.sessionCount,
					inputTokens: window.inputTokens,
					outputTokens: window.outputTokens,
					cacheCreationTokens: window.cacheCreationTokens,
					cacheReadTokens: window.cacheReadTokens,
					totalCost: window.totalCost,
					modelsUsed: window.modelsUsed,
				})),
			})),
		};
		log(JSON.stringify(jsonOutput, null, 2));
		return;
	}

	// Table output
	logger.box('Claude Code 5-Hour Session Windows');

	for (const summary of filteredSummaries) {
		// Monthly header
		let header = `\n${pc.bold(summary.month)}: ${summary.windowCount} sessions`;

		if (summary.sessionLimit != null) {
			const utilPercent = summary.utilizationPercent ?? 0;
			const utilColor = utilPercent >= 90
				? pc.red
				: utilPercent >= 80
					? pc.yellow
					: pc.green;

			header += ` used (${utilColor(`${summary.utilizationPercent?.toFixed(1)}%`)} of ${summary.sessionLimit} limit)`;

			log(header);

			const remaining = summary.remainingSessions ?? 0;
			if (remaining <= 5 && remaining > 0) {
				log(pc.yellow(`[WARNING] Only ${summary.remainingSessions} sessions remaining`));
			}
			else if (summary.remainingSessions === 0) {
				log(pc.red('[LIMIT REACHED] Session limit reached'));
			}
			else {
				log(pc.green(`[OK] ${summary.remainingSessions} sessions remaining`));
			}
		}
		else {
			log(header);
		}

		log(pc.dim('Note: Sessions are counted per calendar month (UTC).'));
		log(pc.dim('Your actual billing cycle may differ.\n'));

		// Create window table
		const table = new ResponsiveTable({
			head: [
				'Window Start',
				'Duration',
				'Messages',
				'Sessions',
				'Tokens',
				'Cost',
			],
			style: {
				head: ['cyan'],
			},
			colAligns: [
				'left',
				'right',
				'right',
				'right',
				'right',
				'right',
			],
			dateFormatter: formatDateCompact,
		});

		// Show top 10 windows
		const windowsToShow = summary.windows.slice(0, 10);

		for (const window of windowsToShow) {
			const startTime = getWindowStartTime(window.windowId);
			const localTime = startTime.toLocaleString();
			const duration = formatDuration(window.duration);
			const totalTokens = window.inputTokens + window.outputTokens
				+ window.cacheCreationTokens + window.cacheReadTokens;

			table.push([
				localTime,
				duration,
				formatNumber(window.messageCount),
				formatNumber(window.sessionCount),
				formatNumber(totalTokens),
				formatCurrency(window.totalCost),
			]);
		}

		if (summary.windows.length > 10) {
			table.push([
				pc.dim(`... and ${summary.windows.length - 10} more windows`),
				'',
				'',
				'',
				'',
				'',
			]);
		}

		// Add totals row
		table.push([
			'─'.repeat(19),
			'─'.repeat(8),
			'─'.repeat(8),
			'─'.repeat(8),
			'─'.repeat(12),
			'─'.repeat(10),
		]);

		table.push([
			pc.yellow('Total'),
			'',
			'',
			formatNumber(summary.windowCount),
			formatNumber(summary.totalTokens),
			formatCurrency(summary.totalCost),
		]);

		log(table.toString());
	}
}
