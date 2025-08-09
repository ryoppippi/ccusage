import type { StatuslineHookJson } from '../_types.ts';
import path from 'node:path';
import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { calculateBurnRate } from '../_session-blocks.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { formatCurrency } from '../_utils.ts';
import { calculateTotals } from '../calculate-cost.ts';
import { getClaudePaths, loadDailyUsageData, loadSessionBlockData, loadSessionData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

/**
 * Reads JSON input from stdin
 * @returns Parsed StatuslineHookJson or null if invalid
 */
async function readStdinJson(): Promise<StatuslineHookJson | null> {
	return new Promise((resolve) => {
		let input = '';
		process.stdin.on('data', (chunk) => {
			input += String(chunk);
		});
		process.stdin.on('end', () => {
			try {
				const data = JSON.parse(input) as unknown;
				const parsed = statuslineHookJsonSchema.safeParse(data);
				if (parsed.success) {
					resolve(parsed.data);
				}
				else {
					logger.error('Invalid input JSON:', parsed.error);
					resolve(null);
				}
			}
			catch (error) {
				logger.error('Failed to parse JSON input:', error);
				resolve(null);
			}
		});
	});
}

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
	args: {},
	async run() {
		// Set logger to silent for statusline output
		logger.level = 0;

		// Read input from stdin
		const hookData = await readStdinJson();
		if (hookData == null) {
			log('❌ Invalid input');
			process.exit(1);
		}

		// Get Claude paths
		const claudePaths = getClaudePaths();
		if (claudePaths.length === 0) {
			log('❌ No Claude data directory found');
			process.exit(1);
		}

		// Extract session ID from transcript path
		// Path format: /path/to/projects/{project}/{session}/transcript.json
		const transcriptParts = hookData.transcript_path.split(path.sep);
		const sessionId = transcriptParts[transcriptParts.length - 2] ?? '';

		// Load current session's cost
		let sessionCost = 0;
		try {
			const sessionData = await loadSessionData({
				mode: 'auto',
			});

			// Find the current session
			const currentSession = sessionData.find(s => s.sessionId === sessionId);
			if (currentSession != null) {
				sessionCost = currentSession.totalCost;
			}
		}
		catch (error) {
			logger.error('Failed to load session data:', error);
		}

		// Load today's usage data
		const today = new Date();
		const todayStr = today.toISOString().split('T')[0];

		let todayCost = 0;
		try {
			const dailyData = await loadDailyUsageData({
				since: todayStr,
				until: todayStr,
				mode: 'auto',
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

		// Get model display name
		const modelName = hookData.model.display_name;

		// Format and output the status line
		// Format: 🤖 model | 💰 session / today / block | 🔥 burn
		const statusLine = `🤖 ${modelName} | 💰 ${formatCurrency(sessionCost)} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnRateInfo}`;

		log(statusLine);
	},
});
