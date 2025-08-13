import process from 'node:process';
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

		// Load current session's cost by finding the specific JSONL file
		let sessionCost: number | null = null;
		try {
			const sessionData = await loadSessionUsageById(sessionId, { mode: 'auto', offline: ctx.values.offline });
			if (sessionData != null) {
				sessionCost = sessionData.totalCost;
			}
		}
		catch (error) {
			logger.error('Failed to load session data:', error);
		}

		// Load today's usage data
		const today = new Date();
		const todayStr = today.toISOString().split('T')[0]?.replace(/-/g, '') ?? ''; // Convert to YYYYMMDD format

		let todayCost = 0;
		try {
			const dailyData = await loadDailyUsageData({
				since: todayStr,
				until: todayStr,
				mode: 'auto',
				offline: ctx.values.offline,
			});

			if (dailyData.length > 0) {
				const totals = calculateTotals(dailyData);
				todayCost = totals.totalCost;
			}
		}
		catch (error) {
			logger.error('Failed to load daily data:', error);
		}

		// Load session block data to find active block
		let blockInfo = '';
		let burnRateInfo = '';
		try {
			const blocks = await loadSessionBlockData({
				mode: 'auto',
				offline: ctx.values.offline,
			});

			// Only identify blocks if we have data
			if (blocks.length === 0) {
				blockInfo = 'No active block';
			}
			else {
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

					blockInfo = `${formatCurrency(blockCost)} block (${formatRemainingTime(remaining)})`;

					// Calculate burn rate
					const burnRate = calculateBurnRate(activeBlock);
					if (burnRate != null) {
						const costPerHour = burnRate.costPerHour;
						const costPerHourStr = `${formatCurrency(costPerHour)}/hr`;

						// Apply color based on burn rate (tokens per minute non-cache)
						let coloredBurnRate = costPerHourStr;
						if (burnRate.tokensPerMinuteForIndicator < 2000) {
							coloredBurnRate = pc.green(costPerHourStr); // Normal
						}
						else if (burnRate.tokensPerMinuteForIndicator < 5000) {
							coloredBurnRate = pc.yellow(costPerHourStr); // Moderate
						}
						else {
							coloredBurnRate = pc.red(costPerHourStr); // High
						}

						burnRateInfo = ` | 🔥 ${coloredBurnRate}`;
					}
				}
				else {
					blockInfo = 'No active block';
				}
			}
		}
		catch (error) {
			logger.error('Failed to load block data:', error);
			blockInfo = 'No active block';
		}

		// Calculate context tokens from transcript
		let contextInfo = '';
		try {
			const contextData = await calculateContextTokens(hookData.transcript_path);
			if (contextData != null) {
				// Format context percentage with color coding using configurable thresholds
				const p = contextData.percentage;
				const thresholds = getContextUsageThresholds();
				const color = p < thresholds.LOW ? pc.green : p < thresholds.MEDIUM ? pc.yellow : pc.red;
				const coloredPercentage = color(`${p}%`);

				// Format token count with thousand separators
				const tokenDisplay = contextData.inputTokens.toLocaleString();
				contextInfo = ` | 🧠 ${tokenDisplay} (${coloredPercentage})`;
			}
		}
		catch (error) {
			logger.debug(`Failed to calculate context tokens: ${error instanceof Error ? error.message : String(error)}`);
		}

		// Get model display name
		const modelName = hookData.model.display_name;

		// Format and output the status line
		// Format: 🤖 model | 💰 session / today / block | 🔥 burn | 🧠 context
		const sessionDisplay = sessionCost !== null ? formatCurrency(sessionCost) : 'N/A';
		const statusLine = `🤖 ${modelName} | 💰 ${sessionDisplay} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnRateInfo}${contextInfo}`;

		log(statusLine);
	},
});
