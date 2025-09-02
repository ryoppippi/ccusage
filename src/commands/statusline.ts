import type { Formatter } from 'picocolors/types';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createLimoJson } from '@ryoppippi/limo';
import getStdin from 'get-stdin';
import { define } from 'gunshi';
import pc from 'picocolors';
import { z } from 'zod';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_CONTEXT_USAGE_THRESHOLDS, DEFAULT_REFRESH_INTERVAL_SECONDS } from '../_consts.ts';
import { calculateBurnRate } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { formatCurrency } from '../_table.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { getFileModifiedTime, unreachable } from '../_utils.ts';
import { calculateTotals } from '../calculate-cost.ts';
import { calculateContextTokens, loadDailyUsageData, loadSessionBlockData, loadSessionUsageById } from '../data-loader.ts';
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
 * Gets semaphore file for session-specific caching and process coordination
 * Uses time-based expiry and transcript file modification detection for cache invalidation
 */
function getSemaphore(sessionId: string): ReturnType<typeof createLimoJson<SemaphoreType | undefined>> {
	const semaphoreDir = join(tmpdir(), 'ccusage-semaphore');
	const semaphorePath = join(semaphoreDir, `${sessionId}.lock`);

	// Ensure semaphore directory exists
	mkdirSync(semaphoreDir, { recursive: true });

	const semaphore = createLimoJson<SemaphoreType>(semaphorePath);
	return semaphore;
}

/**
 * Semaphore structure for hybrid caching system
 * Combines time-based expiry with transcript file modification detection
 */
type SemaphoreType = {
	/** ISO timestamp of last update */
	date: string;
	/** Cached status line output */
	lastOutput: string;
	/** Timestamp (milliseconds) of last successful update for time-based expiry */
	lastUpdateTime: number;
	/** Last processed transcript file path */
	transcriptPath: string;
	/** Last modification time of transcript file for change detection */
	transcriptMtime: number;
	/** Whether another process is currently updating (prevents concurrent updates) */
	isUpdating?: boolean;
	/** Process ID of updating process for deadlock detection */
	pid?: number;
};

const visualBurnRateChoices = ['off', 'emoji', 'text', 'emoji-text'] as const;
const costSourceChoices = ['auto', 'ccusage', 'cc', 'both'] as const;

// Zod schema for context threshold validation
const contextThresholdSchema = z.coerce.number().int().min(0, 'Context threshold must be at least 0').max(100, 'Context threshold must be at most 100');

export const statuslineCommand = define({
	name: 'statusline',
	description: 'Display compact status line for Claude Code hooks with hybrid time+file caching (Beta)',
	toKebab: true,
	args: {
		offline: {
			...sharedArgs.offline,
			default: true, // Default to offline mode for faster performance
		},
		visualBurnRate: {
			type: 'enum',
			choices: visualBurnRateChoices,
			description: 'Controls the visualization of the burn rate status',
			default: 'off',
			// Use capital 'B' to avoid conflicts and follow 1-letter short alias rule
			short: 'B',
			negatable: false,
			toKebab: true,
		},
		costSource: {
			type: 'enum',
			choices: costSourceChoices,
			description: 'Session cost source: auto (prefer CC then ccusage), ccusage (always calculate), cc (always use Claude Code cost), both (show both costs)',
			default: 'auto',
			negatable: false,
			toKebab: true,
		},
		cache: {
			type: 'boolean',
			description: 'Enable cache for status line output (default: true)',
			default: true,
		},
		refreshInterval: {
			type: 'number',
			description: `Refresh interval in seconds for cache expiry (default: ${DEFAULT_REFRESH_INTERVAL_SECONDS})`,
			default: DEFAULT_REFRESH_INTERVAL_SECONDS,
		},
		contextLowThreshold: {
			type: 'custom',
			description: 'Context usage percentage below which status is shown in green (0-100)',
			parse: (value: string) => contextThresholdSchema.parse(value),
			default: DEFAULT_CONTEXT_USAGE_THRESHOLDS.LOW,
		},
		contextMediumThreshold: {
			type: 'custom',
			description: 'Context usage percentage below which status is shown in yellow (0-100)',
			parse: (value: string) => contextThresholdSchema.parse(value),
			default: DEFAULT_CONTEXT_USAGE_THRESHOLDS.MEDIUM,
		},
		config: sharedArgs.config,
		debug: sharedArgs.debug,
	},
	async run(ctx) {
		// Set logger to silent for statusline output
		logger.level = 0;

		// Validate threshold ordering constraint: LOW must be less than MEDIUM
		if (ctx.values.contextLowThreshold >= ctx.values.contextMediumThreshold) {
			throw new Error(`Context low threshold (${ctx.values.contextLowThreshold}) must be less than medium threshold (${ctx.values.contextMediumThreshold})`);
		}

		// Load configuration and merge with CLI args
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// Use refresh interval from merged options
		const refreshInterval = mergedOptions.refreshInterval;

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

		// Extract session ID from hook data
		const sessionId = hookData.session_id;

		/**
		 * Read initial semaphore state for cache validation and process checking
		 * This is a snapshot taken at the beginning to avoid race conditions
		 */
		const initialSemaphoreState = Result.pipe(
			Result.succeed(getSemaphore(sessionId)),
			Result.map(semaphore => semaphore.data),
			Result.unwrap(undefined),
		);

		// Get current file modification time for cache validation and semaphore update
		const currentMtime = await getFileModifiedTime(hookData.transcript_path);

		if (mergedOptions.cache && initialSemaphoreState != null) {
			/**
			 * Hybrid cache validation:
			 * 1. Time-based expiry: Cache expires after refreshInterval seconds
			 * 2. File modification: Immediate invalidation when transcript file is modified
			 * This ensures real-time updates while maintaining good performance
			 */
			const now = Date.now();
			const timeElapsed = now - (initialSemaphoreState.lastUpdateTime ?? 0);
			const isExpired = timeElapsed >= refreshInterval * 1000;
			const isFileModified = initialSemaphoreState.transcriptMtime !== currentMtime;

			if (!isExpired && !isFileModified) {
				// Cache is still valid, return cached output
				log(initialSemaphoreState.lastOutput);
				return;
			}

			// If another process is updating, return stale output
			if (initialSemaphoreState.isUpdating === true) {
				// Check if the updating process is still alive (optional deadlock protection)
				const pid = initialSemaphoreState.pid;
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
					log(initialSemaphoreState.lastOutput);
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
				const currentMtimeForInit = await getFileModifiedTime(hookData.transcript_path);
				semaphore.data = {
					date: new Date().toISOString(),
					lastOutput: '',
					lastUpdateTime: 0,
					transcriptPath: hookData.transcript_path,
					transcriptMtime: currentMtimeForInit,
					isUpdating: true,
					pid: currentPid,
				} as const satisfies SemaphoreType;
			}
		}

		const mainProcessingResult = Result.pipe(
			await Result.try({
				try: async () => {
					// Determine session cost based on cost source
					const { sessionCost, ccCost, ccusageCost } = await (async (): Promise<{ sessionCost?: number; ccCost?: number; ccusageCost?: number }> => {
						const costSource = ctx.values.costSource;

						// Helper function to get ccusage cost
						const getCcusageCost = async (): Promise<number | undefined> => {
							return Result.pipe(
								Result.try({
									try: async () => loadSessionUsageById(sessionId, {
										mode: 'auto',
										offline: mergedOptions.offline,
									}),
									catch: error => error,
								})(),
								Result.map(sessionCost => sessionCost?.totalCost),
								Result.inspectError(error => logger.error('Failed to load session data:', error)),
								Result.unwrap(undefined),
							);
						};

						// If 'both' mode, calculate both costs
						if (costSource === 'both') {
							const ccCost = hookData.cost?.total_cost_usd;
							const ccusageCost = await getCcusageCost();
							return { ccCost, ccusageCost };
						}

						// If 'cc' mode and cost is available from Claude Code, use it
						if (costSource === 'cc') {
							return { sessionCost: hookData.cost?.total_cost_usd };
						}

						// If 'ccusage' mode, always calculate using ccusage
						if (costSource === 'ccusage') {
							const cost = await getCcusageCost();
							return { sessionCost: cost };
						}

						// If 'auto' mode (default), prefer Claude Code cost, fallback to ccusage
						if (costSource === 'auto') {
							if (hookData.cost?.total_cost_usd != null) {
								return { sessionCost: hookData.cost.total_cost_usd };
							}
							// Fallback to ccusage calculation
							const cost = await getCcusageCost();
							return { sessionCost: cost };
						}
						unreachable(costSource);
						return {}; // This line should never be reached
					})();

					// Load today's usage data
					const today = new Date();
					const todayStr = today.toISOString().split('T')[0]?.replace(/-/g, '') ?? ''; // Convert to YYYYMMDD format

					const todayCost = await Result.pipe(
						Result.try({
							try: async () => loadDailyUsageData({
								since: todayStr,
								until: todayStr,
								mode: 'auto',
								offline: mergedOptions.offline,
							}),
							catch: error => error,
						})(),
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
							try: async () => loadSessionBlockData({
								mode: 'auto',
								offline: mergedOptions.offline,
							}),
							catch: error => error,
						})(),
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
											const renderEmojiStatus = ctx.values.visualBurnRate === 'emoji' || ctx.values.visualBurnRate === 'emoji-text';
											const renderTextStatus = ctx.values.visualBurnRate === 'text' || ctx.values.visualBurnRate === 'emoji-text';
											const costPerHour = burnRate.costPerHour;
											const costPerHourStr = `${formatCurrency(costPerHour)}/hr`;

											type BurnStatus = 'normal' | 'moderate' | 'high';

											const burnStatus: BurnStatus = burnRate.tokensPerMinuteForIndicator < 2000
												? 'normal'
												: burnRate.tokensPerMinuteForIndicator < 5000
													? 'moderate'
													: 'high';

											const burnStatusMappings: Record<BurnStatus, { emoji: string; textValue: string; coloredString: Formatter }> = {
												normal: { emoji: '🟢', textValue: 'Normal', coloredString: pc.green },
												moderate: { emoji: '⚠️', textValue: 'Moderate', coloredString: pc.yellow },
												high: { emoji: '🚨', textValue: 'High', coloredString: pc.red },
											};

											const { emoji, textValue, coloredString } = burnStatusMappings[burnStatus];

											const burnRateOutputSegments: string[] = [
												coloredString(costPerHourStr),
											];

											if (renderEmojiStatus) {
												burnRateOutputSegments.push(emoji);
											}

											if (renderTextStatus) {
												burnRateOutputSegments.push(coloredString(`(${textValue})`));
											}

											return ` | 🔥 ${burnRateOutputSegments.join(' ')}`;
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
							try: calculateContextTokens(hookData.transcript_path, hookData.model.id, mergedOptions.offline),
							catch: error => error,
						}),
						Result.inspectError(error => logger.debug(`Failed to calculate context tokens: ${error instanceof Error ? error.message : String(error)}`)),
						Result.map((contextResult) => {
							if (contextResult == null) {
								return undefined;
							}
							// Format context percentage with color coding using option thresholds
							const color = contextResult.percentage < ctx.values.contextLowThreshold
								? pc.green
								: contextResult.percentage < ctx.values.contextMediumThreshold
									? pc.yellow
									: pc.red;
							const coloredPercentage = color(`${contextResult.percentage}%`);

							// Format token count with thousand separators
							const tokenDisplay = contextResult.inputTokens.toLocaleString();
							return `${tokenDisplay} (${coloredPercentage})`;
						}),
						Result.unwrap(undefined),
					);

					// Get model display name
					const modelName = hookData.model.display_name;

					// Format and output the status line
					// Format: 🤖 model | 💰 session / today / block | 🔥 burn | 🧠 context
					const sessionDisplay = (() => {
						// If both costs are available, show them side by side
						if (ccCost != null || ccusageCost != null) {
							const ccDisplay = ccCost != null ? formatCurrency(ccCost) : 'N/A';
							const ccusageDisplay = ccusageCost != null ? formatCurrency(ccusageCost) : 'N/A';
							return `(${ccDisplay} cc / ${ccusageDisplay} ccusage)`;
						}
						// Single cost display
						return sessionCost != null ? formatCurrency(sessionCost) : 'N/A';
					})();
					const statusLine = `🤖 ${modelName} | 💰 ${sessionDisplay} session / ${formatCurrency(todayCost)} today / ${blockInfo}${burnRateInfo} | 🧠 ${contextInfo ?? 'N/A'}`;
					return statusLine;
				},
				catch: error => error,
			})(),
		);

		if (Result.isSuccess(mainProcessingResult)) {
			const statusLine = mainProcessingResult.value;
			log(statusLine);
			if (!mergedOptions.cache) {
				return;
			}
			// update semaphore with result (use mtime from cache validation time)
			using semaphore = getSemaphore(sessionId);
			semaphore.data = {
				date: new Date().toISOString(),
				lastOutput: statusLine,
				lastUpdateTime: Date.now(),
				transcriptPath: hookData.transcript_path,
				transcriptMtime: currentMtime, // Use mtime from when we started processing
				isUpdating: false,
				pid: undefined,
			};
			return;
		}

		// Handle processing result
		if (Result.isFailure(mainProcessingResult)) {
			// Reset updating flag on error to prevent deadlock

			// If we have a cached output from previous run, use it
			if (initialSemaphoreState?.lastOutput != null && initialSemaphoreState.lastOutput !== '') {
				log(initialSemaphoreState.lastOutput);
			}
			else {
				// Fallback minimal output
				log('❌ Error generating status');
			}

			logger.error('Error in statusline command:', mainProcessingResult.error);

			if (!mergedOptions.cache) {
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
