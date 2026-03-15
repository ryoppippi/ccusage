import type { Formatter } from 'picocolors/types';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { formatCompactTokens, formatCurrency } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { createLimoJson } from '@ryoppippi/limo';
import getStdin from 'get-stdin';
import { define } from 'gunshi';
import pc from 'picocolors';
import * as v from 'valibot';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_CONTEXT_USAGE_THRESHOLDS, DEFAULT_REFRESH_INTERVAL_SECONDS } from '../_consts.ts';
import { getEnhancedPromotionSegment, getPromotionStatuslineSegment } from '../_promotions.ts';
import { calculateBurnRate } from '../_session-blocks.ts';
import { sharedArgs } from '../_shared-args.ts';
import { statuslineHookJsonSchema } from '../_types.ts';
import { getFileModifiedTime, unreachable } from '../_utils.ts';
import { calculateTotals } from '../calculate-cost.ts';
import {
	calculateContextTokens,
	loadDailyUsageData,
	loadSessionBlockData,
	loadSessionUsageById,
} from '../data-loader.ts';
import { log, logger } from '../logger.ts';

/**
 * Formats the remaining time for compact display
 * @param remaining - Remaining minutes
 * @returns Compact time string (e.g., "4h30m")
 */
function formatRemainingTime(remaining: number): string {
	const remainingHours = Math.floor(remaining / 60);
	const remainingMins = remaining % 60;

	if (remainingHours > 0) {
		return `${remainingHours}h${remainingMins}m`;
	}
	return `${remainingMins}m`;
}

/**
 * Gets semaphore file for session-specific caching and process coordination
 * Uses time-based expiry and transcript file modification detection for cache invalidation
 */
function getSemaphore(
	sessionId: string,
): ReturnType<typeof createLimoJson<SemaphoreType | undefined>> {
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
const promotionDisplayChoices = ['auto', 'active-only', 'off'] as const;

// Valibot schema for context threshold validation
const contextThresholdSchema = v.pipe(
	v.union([
		v.number(),
		v.pipe(
			v.string(),
			v.trim(),
			v.check((value) => /^-?\d+$/u.test(value), 'Context threshold must be an integer'),
			v.transform((value) => Number.parseInt(value, 10)),
		),
	]),
	v.number('Context threshold must be a number'),
	v.integer('Context threshold must be an integer'),
	v.minValue(0, 'Context threshold must be at least 0'),
	v.maxValue(100, 'Context threshold must be at most 100'),
);

function parseContextThreshold(value: string): number {
	return v.parse(contextThresholdSchema, value);
}

export const statuslineCommand = define({
	name: 'statusline',
	description:
		'Display compact status line for Claude Code hooks with hybrid time+file caching (Beta)',
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
			description:
				'Session cost source: auto (prefer CC then ccusage), ccusage (always calculate), cc (always use Claude Code cost), both (show both costs)',
			default: 'auto',
			negatable: false,
			toKebab: true,
		},
		cache: {
			type: 'boolean',
			description: 'Enable cache for status line output (default: true)',
			negatable: true,
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
			parse: (value) => parseContextThreshold(value),
			default: DEFAULT_CONTEXT_USAGE_THRESHOLDS.LOW,
		},
		contextMediumThreshold: {
			type: 'custom',
			description: 'Context usage percentage below which status is shown in yellow (0-100)',
			parse: (value) => parseContextThreshold(value),
			default: DEFAULT_CONTEXT_USAGE_THRESHOLDS.MEDIUM,
		},
		showPromotions: {
			type: 'boolean',
			description: 'Show active promotions in statusline (default: true)',
			negatable: true,
			default: true,
			toKebab: true,
		},
		promotionDisplay: {
			type: 'enum',
			choices: promotionDisplayChoices,
			description:
				'Promotion display mode: auto (always show with countdown during peak), active-only (only during off-peak), off (disable)',
			default: 'auto',
			negatable: false,
			toKebab: true,
		},
		showSessionDuration: {
			type: 'boolean',
			description: 'Show session duration in statusline (default: true)',
			negatable: true,
			default: true,
			toKebab: true,
		},
		showLinesChanged: {
			type: 'boolean',
			description: 'Show lines added/removed in statusline (default: true)',
			negatable: true,
			default: true,
			toKebab: true,
		},
		config: sharedArgs.config,
		debug: sharedArgs.debug,
	},
	async run(ctx) {
		// Set logger to silent for statusline output
		logger.level = 0;

		// Validate threshold ordering constraint: LOW must be less than MEDIUM
		if (ctx.values.contextLowThreshold >= ctx.values.contextMediumThreshold) {
			throw new Error(
				`Context low threshold (${ctx.values.contextLowThreshold}) must be less than medium threshold (${ctx.values.contextMediumThreshold})`,
			);
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
		const hookDataParseResult = v.safeParse(statuslineHookJsonSchema, hookDataJson);
		if (!hookDataParseResult.success) {
			log('❌ Invalid input format:', v.flatten(hookDataParseResult.issues));
			process.exit(1);
		}
		const hookData = hookDataParseResult.output;

		// Extract session ID from hook data
		const sessionId = hookData.session_id;

		/**
		 * Read initial semaphore state for cache validation and process checking
		 * This is a snapshot taken at the beginning to avoid race conditions
		 */
		const initialSemaphoreState = Result.pipe(
			Result.succeed(getSemaphore(sessionId)),
			Result.map((semaphore) => semaphore.data),
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
					} catch {
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
			} else {
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
					const { sessionCost, ccCost, ccusageCost } = await (async (): Promise<{
						sessionCost?: number;
						ccCost?: number;
						ccusageCost?: number;
					}> => {
						const costSource = ctx.values.costSource;

						// Helper function to get ccusage cost
						const getCcusageCost = async (): Promise<number | undefined> => {
							return Result.pipe(
								Result.try({
									try: async () =>
										loadSessionUsageById(sessionId, {
											mode: 'auto',
											offline: mergedOptions.offline,
										}),
									catch: (error) => error,
								})(),
								Result.map((sessionCost) => sessionCost?.totalCost),
								Result.inspectError((error) => logger.error('Failed to load session data:', error)),
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
							try: async () =>
								loadDailyUsageData({
									since: todayStr,
									until: todayStr,
									mode: 'auto',
									offline: mergedOptions.offline,
								}),
							catch: (error) => error,
						})(),
						Result.map((dailyData) => {
							if (dailyData.length > 0) {
								const totals = calculateTotals(dailyData);
								return totals.totalCost;
							}
							return 0;
						}),
						Result.inspectError((error) => logger.error('Failed to load daily data:', error)),
						Result.unwrap(0),
					);

					// Load session block data to find active block
					const { blockCostStr, blockTimeStr, burnRateInfo } = await Result.pipe(
						Result.try({
							try: async () =>
								loadSessionBlockData({
									mode: 'auto',
									offline: mergedOptions.offline,
								}),
							catch: (error) => error,
						})(),
						Result.map((blocks) => {
							// Only identify blocks if we have data
							if (blocks.length === 0) {
								return { blockCostStr: '$0.00', blockTimeStr: '', burnRateInfo: '' };
							}

							// Find active block
							const activeBlock = blocks.find((block) => block.isActive);

							if (activeBlock != null) {
								const now = new Date();
								const remaining = Math.round(
									(activeBlock.endTime.getTime() - now.getTime()) / (1000 * 60),
								);
								const blockCostStr = formatCurrency(activeBlock.costUSD);
								const blockTimeStr = formatRemainingTime(remaining);

								// Calculate burn rate
								const burnRate = calculateBurnRate(activeBlock);
								const burnRateInfo =
									burnRate != null
										? (() => {
												const renderEmojiStatus =
													ctx.values.visualBurnRate === 'emoji' ||
													ctx.values.visualBurnRate === 'emoji-text';
												const renderTextStatus =
													ctx.values.visualBurnRate === 'text' ||
													ctx.values.visualBurnRate === 'emoji-text';
												const costPerHour = burnRate.costPerHour;
												const costPerHourStr = `${formatCurrency(costPerHour)}/hr`;

												type BurnStatus = 'normal' | 'moderate' | 'high';

												const burnStatus: BurnStatus =
													burnRate.tokensPerMinuteForIndicator < 2000
														? 'normal'
														: burnRate.tokensPerMinuteForIndicator < 5000
															? 'moderate'
															: 'high';

												const burnStatusMappings: Record<
													BurnStatus,
													{ emoji: string; textValue: string; coloredString: Formatter }
												> = {
													normal: { emoji: '🟢', textValue: 'Normal', coloredString: pc.green },
													moderate: {
														emoji: '⚠️',
														textValue: 'Moderate',
														coloredString: pc.yellow,
													},
													high: { emoji: '🚨', textValue: 'High', coloredString: pc.red },
												};

												const { emoji, textValue, coloredString } = burnStatusMappings[burnStatus];

												const burnRateOutputSegments: string[] = [coloredString(costPerHourStr)];

												if (renderEmojiStatus) {
													burnRateOutputSegments.push(emoji);
												}

												if (renderTextStatus) {
													burnRateOutputSegments.push(coloredString(`(${textValue})`));
												}

												return ` ${burnRateOutputSegments.join(' ')}`;
											})()
										: '';

								return { blockCostStr, blockTimeStr, burnRateInfo };
							}

							return { blockCostStr: '$0.00', blockTimeStr: '', burnRateInfo: '' };
						}),
						Result.inspectError((error) => logger.error('Failed to load block data:', error)),
						Result.unwrap({ blockCostStr: '$0.00', blockTimeStr: '', burnRateInfo: '' }),
					);

					// Helper function to format context percentage with color coding
					const formatContextPercentage = (inputTokens: number, contextLimit: number): string => {
						const percentage = Math.round((inputTokens / contextLimit) * 100);
						const color =
							percentage < ctx.values.contextLowThreshold
								? pc.green
								: percentage < ctx.values.contextMediumThreshold
									? pc.yellow
									: pc.red;
						return `${color(`${percentage}%`)} ${pc.dim('ctx')}`;
					};

					// Get context tokens from Claude Code hook data, or fall back to calculating from transcript
					const contextDataResult =
						hookData.context_window != null
							? // Prefer context_window data from Claude Code hook if available
								Result.succeed({
									inputTokens: hookData.context_window.total_input_tokens,
									outputTokens: hookData.context_window.total_output_tokens ?? 0,
									contextLimit: hookData.context_window.context_window_size,
								})
							: // Fall back to calculating context tokens from transcript
								await Result.try({
									try: async () => {
										const result = await calculateContextTokens(
											hookData.transcript_path,
											hookData.model.id,
											mergedOptions.offline,
										);
										return result != null ? { ...result, outputTokens: 0 } : null;
									},
									catch: (error) => error,
								})();

					const contextData = Result.pipe(
						contextDataResult,
						Result.inspectError((error) =>
							logger.debug(
								`Failed to calculate context tokens: ${error instanceof Error ? error.message : String(error)}`,
							),
						),
						Result.unwrap(null),
					);

					// Build token breakdown segment: ↑35K ↓2.5K
					const tokenSegment =
						contextData != null
							? `${pc.green(`\u2191${formatCompactTokens(contextData.inputTokens)}`)} ${pc.magenta(`\u2193${formatCompactTokens(contextData.outputTokens)}`)}`
							: '';

					// Build context percentage segment: 17% ctx
					const contextSegment =
						contextData != null
							? formatContextPercentage(contextData.inputTokens, contextData.contextLimit)
							: '';

					// Get model display name
					const modelName = hookData.model.display_name;

					// Build session cost display
					const sessionDisplay = (() => {
						if (ccCost != null || ccusageCost != null) {
							const ccDisplay = ccCost != null ? formatCurrency(ccCost) : 'N/A';
							const ccusageDisplay = ccusageCost != null ? formatCurrency(ccusageCost) : 'N/A';
							return `(${pc.cyan(ccDisplay)} ${pc.dim('cc')} / ${pc.cyan(ccusageDisplay)} ${pc.dim('ccusage')})`;
						}
						return sessionCost != null ? pc.cyan(formatCurrency(sessionCost)) : 'N/A';
					})();

					// Build cost segment with burn rate separated by pipe
					const dot = pc.dim(' · ');
					const costParts = `${sessionDisplay} ${pc.dim('session')}${dot}${pc.cyan(formatCurrency(todayCost))} ${pc.dim('today')}${dot}${pc.cyan(blockCostStr)} ${pc.dim('block')} ${pc.dim(blockTimeStr)}`;
					const costSegment =
						burnRateInfo !== '' ? `${costParts} ${pc.dim('|')}${burnRateInfo}` : costParts;

					// Build session activity segment: duration + lines changed
					const sessionActivityParts: string[] = [];
					if (ctx.values.showSessionDuration && hookData.cost?.total_duration_ms != null) {
						const durationMin = Math.round(hookData.cost.total_duration_ms / 60_000);
						if (durationMin > 0) {
							sessionActivityParts.push(pc.dim(formatRemainingTime(durationMin)));
						}
					}
					if (ctx.values.showLinesChanged) {
						const added = hookData.cost?.total_lines_added;
						const removed = hookData.cost?.total_lines_removed;
						if (added != null || removed != null) {
							const parts: string[] = [];
							if (added != null && added > 0) {
								parts.push(pc.green(`+${added}`));
							}
							if (removed != null && removed > 0) {
								parts.push(pc.red(`-${removed}`));
							}
							if (parts.length > 0) {
								sessionActivityParts.push(parts.join(' '));
							}
						}
					}
					const sessionActivitySegment = sessionActivityParts.join(' ');

					// Build promotion segment with configurable display mode
					const promotionSegment = (() => {
						if (!ctx.values.showPromotions || ctx.values.promotionDisplay === 'off') {
							return '';
						}
						if (ctx.values.promotionDisplay === 'active-only') {
							return getPromotionStatuslineSegment();
						}
						// 'auto' mode — show enhanced promotion with countdown during peak
						return getEnhancedPromotionSegment();
					})();

					// Assemble status line from segments
					const segments = [
						pc.bold(modelName),
						costSegment,
						tokenSegment,
						contextSegment,
						sessionActivitySegment,
						promotionSegment,
					].filter((s) => s !== '');

					const pipe = pc.dim(' | ');
					const statusLine = segments.join(pipe);
					return statusLine;
				},
				catch: (error) => error,
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
			} else {
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
