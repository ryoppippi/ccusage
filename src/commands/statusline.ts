import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createLimoJson } from '@ryoppippi/limo';
import getStdin from 'get-stdin';
import { define } from 'gunshi';
import pc from 'picocolors';
import { calculateBurnRate } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { formatCurrency } from '../_utils.ts';
import { calculateTotals } from '../calculate-cost.ts';
import { calculateContextTokens, getContextUsageThresholds, loadDailyUsageData, loadSessionBlockData, loadSessionUsageById } from '../data-loader.ts';
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

function getSemaphore(sessionId: string): ReturnType<typeof createLimoJson<SemaphoreType>> {
	const semaphoreDir = join(tmpdir(), 'ccusage-semaphore');
	const semaphorePath = join(semaphoreDir, `${sessionId}.lock`);

	// Ensure semaphore directory exists
	mkdirSync(semaphoreDir, { recursive: true });

	const semaphore = createLimoJson<SemaphoreType>(semaphorePath);
	return semaphore;
}

type SemaphoreType = {
	date: string;
	lastOutput: string;
	inputHash: string;
	isUpdating?: boolean;
	pid?: number;
};

export const statuslineCommand = define({
	name: 'statusline',
	description: 'Display compact status line for Claude Code hooks (Beta)',
	args: {
		offline: {
			...sharedArgs.offline,
			default: true, // Default to offline mode for faster performance
		},
		cache: {
			type: 'boolean',
			description: 'Enable cache for status line output (default: true)',
			default: true,
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

		// Calculate hash of input for cache comparison (using md5 for speed)
		const inputHash = createHash('md5').update(stdin.trim()).digest('hex');

		// Parse input as JSON
		const hookDataJson: unknown = JSON.parse(stdin.trim());
		const hookDataParseResult = statuslineHookJsonSchema.safeParse(hookDataJson);
		if (!hookDataParseResult.success) {
			log('❌ Invalid input format:', hookDataParseResult.error.message);
			process.exit(1);
		}
		const hookData = hookDataParseResult.data;

		// Extract session ID from hook data
		const sessionId = hookData.session_id;

		const cachedData = Result.pipe(
			Result.succeed(getSemaphore(sessionId)),
			Result.map(semaphore => semaphore.data),
			Result.unwrap(undefined),
		);

		if (ctx.values.cache && cachedData != null) {
			const isSameInput = cachedData.inputHash === inputHash;

			if (isSameInput) {
				// If same input, return cached output
				log(cachedData.lastOutput);
				return;
			}

			// If another process is updating, return stale output
			if (cachedData.isUpdating === true) {
				// Check if the updating process is still alive (optional deadlock protection)
				const pid = cachedData.pid;
				let isProcessAlive = false;
				if (pid != null) {
					try {
						process.kill(pid, 0); // Signal 0 doesn't kill, just checks if process exists
						isProcessAlive = true;
					}
					catch {
						// Process doesn't exist, likely dead
						isProcessAlive = false;
					}
				}

				if (isProcessAlive) {
					// Another process is actively updating, return stale output
					log(cachedData.lastOutput);
					return;
				}
				// Process is dead, continue to update ourselves
			}
		}

		// Acquisition phase: Mark as updating
		{
			const currentPid = process.pid;
			using semaphore = getSemaphore(sessionId);
			if (semaphore.data != null) {
				semaphore.data = {
					...semaphore.data,
					isUpdating: true,
					pid: currentPid,
				} as const satisfies SemaphoreType;
			}
			else {
				semaphore.data = {
					date: new Date().toISOString(),
					lastOutput: '',
					inputHash: '',
					isUpdating: true,
					pid: currentPid,
				} as const satisfies SemaphoreType;
			}
		}

		const mainProcessingResult = Result.pipe(
			await Result.try({
				try: async () => {
					const sessionCost = await Result.pipe(
						Result.try({
							try: loadSessionUsageById(sessionId, {
								mode: 'auto',
								offline: ctx.values.offline,
							}),
							catch: error => error,
						}),
						Result.map(sessionCost => sessionCost?.totalCost),
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

					// Calculate context tokens from transcript with model-specific limits
					const contextInfo = await Result.pipe(
						Result.try({
							try: calculateContextTokens(hookData.transcript_path, hookData.model.id, ctx.values.offline),
							catch: error => error,
						}),
						Result.inspectError(error => logger.debug(`Failed to calculate context tokens: ${error instanceof Error ? error.message : String(error)}`)),
						Result.map((ctx) => {
							if (ctx == null) {
								return undefined;
							}
							// Format context percentage with color coding using configurable thresholds
							const thresholds = getContextUsageThresholds();
							const color = ctx.percentage < thresholds.LOW
								? pc.green
								: ctx.percentage < thresholds.MEDIUM
									? pc.yellow
									: pc.red;
							const coloredPercentage = color(`${ctx.percentage}%`);

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
					return statusLine;
				},
				catch: error => error,
			})(),
		);

		if (Result.isSuccess(mainProcessingResult)) {
			const statusLine = mainProcessingResult.value;
			log(statusLine);
			if (!ctx.values.cache) {
				return;
			}
			// update semaphore with result
			using semaphore = getSemaphore(sessionId);
			semaphore.data = {
				date: new Date().toISOString(),
				lastOutput: statusLine,
				inputHash,
				isUpdating: false,
				pid: undefined,
			};
			return;
		}

		// Handle processing result
		if (Result.isFailure(mainProcessingResult)) {
			// Reset updating flag on error to prevent deadlock

			// If we have a cached output from previous run, use it
			if (cachedData?.lastOutput !== undefined && cachedData.lastOutput !== '') {
				log(cachedData.lastOutput);
			}
			else {
				// Fallback minimal output
				log('❌ Error generating status');
			}

			logger.error('Error in statusline command:', mainProcessingResult.error);

			if (!ctx.values.cache) {
				return;
			}

			// Release semaphore and reset updating flag
			using semaphore = getSemaphore(sessionId);
			if (semaphore.data != null) {
				semaphore.data.isUpdating = false;
				semaphore.data.pid = undefined;
			}
		}
	},
});
