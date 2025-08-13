import process from 'node:process';
import { Result } from '@praha/byethrow';
import getStdin from 'get-stdin';
import { define } from 'gunshi';
import pc from 'picocolors';
import { calculateBurnRate } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { formatCurrency } from '../_utils.ts';
import { calculateTotals } from '../calculate-cost.ts';
import { calculateContextTokens, getClaudePaths, getContextUsageThresholds, loadDailyUsageData, loadSessionBlockData, loadSessionUsageById } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

/**
 * Formats the remaining time for display
 * @param remaining - Remaining minutes
 * @returns Formatted time string
 */
function formatRemainingTime(remaining: number): string {
	const remainingHours = Math.floor(remaining / 60);
	const remainingMins = remaining % 60;

	if (remainingHours > 0) {
		return `${remainingHours}h ${remainingMins}m left`;
	}
	return `${remainingMins}m left`;
}

export const statuslineCommand = define({
	name: 'statusline',
	description: 'Display compact status line for Claude Code hooks (Beta)',
	args: {
		offline: {
			...sharedArgs.offline,
			default: true, // Default to offline mode for faster performance
		},
	},
	async run(ctx) {
		// Set logger to silent for statusline output
		logger.level = 0;

		// Read input from stdin
		const stdin = await getStdin();
		if (stdin.length === 0) {
			log('❌ No input provided');
			process.exit(1);
		}
		// Parse input as JSON
		const hookDataJson: unknown = JSON.parse(stdin.trim());
		const hookDataParseResult = statuslineHookJsonSchema.safeParse(hookDataJson);
		if (!hookDataParseResult.success) {
			log('❌ Invalid input format:', hookDataParseResult.error.message);
			process.exit(1);
		}
		const hookData = hookDataParseResult.data;

		// Get Claude paths
		const claudePaths = getClaudePaths();
		if (claudePaths.length === 0) {
			log('❌ No Claude data directory found');
			process.exit(1);
		}

		// Extract session ID from hook data
		const sessionId = hookData.session_id;

		const sessionCost = await Result.pipe(
			Result.try({
				try: loadSessionUsageById(sessionId, {
					mode: 'auto',
					offline: ctx.values.offline,
				}),
				catch: error => error,
			}),
			Result.map((sessionCost) => {
				return sessionCost?.totalCost;
			}),
			Result.inspectError(error => logger.error('Failed to load session data:', error)),
			Result.unwrap(undefined),
		);

		// Load today's usage data
		const today = new Date();
		const todayStr = today.toISOString().split('T')[0]?.replace(/-/g, '') ?? ''; // Convert to YYYYMMDD format

		const todayCost = await Result.pipe(
			Result.try({
				try: loadDailyUsageData({
					since: todayStr,
					until: todayStr,
					mode: 'auto',
					offline: ctx.values.offline,
				}),
				catch: error => error,
			}),
			Result.map((dailyData) => {
				if (dailyData.length > 0) {
					const totals = calculateTotals(dailyData);
					return totals.totalCost;
				}
				return 0;
			}),
			Result.inspectError(error => logger.error('Failed to load daily data:', error)),
			Result.unwrap(0),
		);

		// Load session block data to find active block
		const { blockInfo, burnRateInfo } = await Result.pipe(
			Result.try({
				try: loadSessionBlockData({
					mode: 'auto',
					offline: ctx.values.offline,
				}),
				catch: error => error,
			}),
			Result.map((blocks) => {
				// Only identify blocks if we have data
				if (blocks.length === 0) {
					return { blockInfo: 'No active block', burnRateInfo: '' };
				}

				// Find active block that contains our session
				const activeBlock = blocks.find((block) => {
					if (!block.isActive) {
						return false;
					}

					// Check if any entry in this block matches our session
					// Since we don't have direct session mapping in entries,
					// we use the active block that's currently running
					return true;
				});

				if (activeBlock != null) {
					const now = new Date();
					const remaining = Math.round((activeBlock.endTime.getTime() - now.getTime()) / (1000 * 60));
					const blockCost = activeBlock.costUSD;

					const blockInfo = `${formatCurrency(blockCost)} block (${formatRemainingTime(remaining)})`;

					// Calculate burn rate
					const burnRate = calculateBurnRate(activeBlock);
					const burnRateInfo = burnRate != null
						? (() => {
								const costPerHour = burnRate.costPerHour;
								const costPerHourStr = `${formatCurrency(costPerHour)}/hr`;

								// Apply color based on burn rate (tokens per minute non-cache)
								const coloredBurnRate = burnRate.tokensPerMinuteForIndicator < 2000
									? pc.green(costPerHourStr) // Normal
									: burnRate.tokensPerMinuteForIndicator < 5000
										? pc.yellow(costPerHourStr) // Moderate
										: pc.red(costPerHourStr); // High

								return ` | 🔥 ${coloredBurnRate}`;
							})()
						: '';

					return { blockInfo, burnRateInfo };
				}

				return { blockInfo: 'No active block', burnRateInfo: '' };
			}),
			Result.inspectError(error => logger.error('Failed to load block data:', error)),
			Result.unwrap({ blockInfo: 'No active block', burnRateInfo: '' }),
		);

		// Calculate context tokens from transcript
		const contextInfo = await Result.pipe(
			Result.try({
				try: calculateContextTokens(hookData.transcript_path),
				catch: error => error,
			}),
			Result.inspectError(error => logger.debug(`Failed to calculate context tokens: ${error instanceof Error ? error.message : String(error)}`)),
			Result.map((ctx) => {
				if (ctx == null) {
					return undefined;
				}
				// Format context percentage with color coding using configurable thresholds
				const p = ctx.percentage;
				const thresholds = getContextUsageThresholds();
				const color = p < thresholds.LOW ? pc.green : p < thresholds.MEDIUM ? pc.yellow : pc.red;
				const coloredPercentage = color(`${p}%`);

				// Format token count with thousand separators
				const tokenDisplay = ctx.inputTokens.toLocaleString();
				return `${tokenDisplay} (${coloredPercentage})`;
			}),
			Result.unwrap(undefined),
		);

		// Get model display name
		const modelName = hookData.model.display_name;

		// Format and output the status line
		// Format: 🤖 model | 💰 session / today / block | 🔥 burn | 🧠 context
		const sessionDisplay = sessionCost != null ? formatCurrency(sessionCost) : 'N/A';
		const statusLine = `🤖 ${modelName} | 💰 ${sessionDisplay} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnRateInfo} | 🧠 ${contextInfo ?? 'N/A'}`;

		log(statusLine);
	},
});
