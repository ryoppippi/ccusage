import { readFile } from 'node:fs/promises';
import process from 'node:process';
import getStdin from 'get-stdin';
import { define } from 'gunshi';
import pc from 'picocolors';
import { calculateBurnRate } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { formatCurrency } from '../_utils.ts';
import { calculateTotals } from '../calculate-cost.ts';
import { getClaudePaths, loadDailyUsageData, loadSessionBlockData, loadSessionUsageById } from '../data-loader.ts';
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

/**
 * Interface for transcript structure
 */
type TranscriptUsage = {
	input_tokens?: number;
};

type TranscriptMessage = {
	usage?: TranscriptUsage;
};

type TranscriptData = {
	messages?: TranscriptMessage[];
	usage?: TranscriptUsage;
};

/**
 * Calculate context tokens from transcript file
 * @param transcriptPath - Path to the transcript JSON file
 * @returns Object with context tokens info or null if unavailable
 */
async function calculateContextTokens(transcriptPath: string): Promise<{
	totalInputTokens: number;
	percentage: number;
	contextLimit: number;
} | null> {
	let transcript: TranscriptData;
	try {
		const content = await readFile(transcriptPath, 'utf-8');
		transcript = JSON.parse(content) as TranscriptData;
	}
	catch (error) {
		logger.debug('Failed to read transcript file:', error);
		return null;
	}

	// Calculate total input tokens from all messages with usage information
	let totalInputTokens = 0;
	const contextLimit = 200000; // Default Claude 4 context limit
	let foundUsage = false;

	// Look for usage information in the transcript
	if (transcript.messages != null && Array.isArray(transcript.messages)) {
		for (const message of transcript.messages) {
			if (message.usage?.input_tokens != null) {
				totalInputTokens = Math.max(totalInputTokens, message.usage.input_tokens);
				foundUsage = true;
			}
		}
	}

	// If no usage found in messages, check if there's a direct usage field
	if (!foundUsage && transcript.usage?.input_tokens != null) {
		totalInputTokens = transcript.usage.input_tokens;
		foundUsage = true;
	}

	// If still no usage found, return null
	if (!foundUsage) {
		logger.debug('No usage information found in transcript');
		return null;
	}

	// Calculate percentage
	const percentage = Math.round((totalInputTokens / contextLimit) * 100);

	return {
		totalInputTokens,
		percentage,
		contextLimit,
	};
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
				// Format context percentage with color coding
				let coloredPercentage = `${contextData.percentage}%`;
				if (contextData.percentage < 50) {
					coloredPercentage = pc.green(`${contextData.percentage}%`);
				}
				else if (contextData.percentage < 80) {
					coloredPercentage = pc.yellow(`${contextData.percentage}%`);
				}
				else {
					coloredPercentage = pc.red(`${contextData.percentage}%`);
				}

				// Format token count with thousand separators
				const tokenDisplay = contextData.totalInputTokens.toLocaleString();
				contextInfo = ` | 🧠 ${tokenDisplay} (${coloredPercentage})`;
			}
		}
		catch (error) {
			logger.debug('Failed to calculate context tokens:', error);
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
