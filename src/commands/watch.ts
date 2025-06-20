import type { DisplayOptions } from '../types.internal.ts';
import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { getDefaultClaudePath, loadSessionBlockData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';
import { calculateModelBreakdown, createProgressBar, displayCostProgressBar } from '../progress-bar.internal.ts';
import {
	calculateBurnRate,
	calculateBurnRateAnalysis,
	DEFAULT_SESSION_DURATION_HOURS,
	projectBlockUsage,
	type SessionBlock,
	TIME_CONSTANTS,
} from '../session-blocks.internal.ts';
import { createSessionTracker, type SessionTracker } from '../session-tracker.internal.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import { displayCostTable, displayPeriodTable, displayTokensTable } from '../table-display.internal.ts';
import { clearScreen, formatCurrency, formatDuration, formatNumber } from '../utils.internal.ts';

/**
 * Represents the current state of the active block for change detection
 */
type BlockState = {
	tokenCount: number;
	costUSD: number;
	burnRate: number | null;
	lastUpdate: Date;
	lastChangeTime: Date;
};

/**
 * Constants for timing
 */
const BLOCK_DURATION_MINUTES = DEFAULT_SESSION_DURATION_HOURS * 60;

/**
 * Time warning thresholds in minutes
 */
const TIME_WARNING_THRESHOLDS = {
	CRITICAL: 30, // Red warning when 30 minutes or less remaining
	WARNING: 60, // Yellow warning when 1 hour or less remaining
};

/**
 * Updates intervals in milliseconds for adaptive updating
 */
const UPDATE_INTERVALS = {
	FAST: 5000, // 5 seconds
	MEDIUM: 15000, // 15 seconds
	SLOW: 60000, // 60 seconds (1 minute)
};

/**
 * Compares two block states to detect changes
 * @param current - Current block state
 * @param previous - Previous block state
 * @returns True if significant changes detected
 */
function hasSignificantChanges(current: BlockState, previous: BlockState | null): boolean {
	if (previous == null) {
		return true;
	}

	// Check for token count changes
	if (current.tokenCount !== previous.tokenCount) {
		return true;
	}

	// Check for cost changes (with small tolerance for floating point)
	if (Math.abs(current.costUSD - previous.costUSD) > 0.0001) {
		return true;
	}

	return false;
}

/**
 * Gets the next update interval based on change detection and inactivity duration
 * @param hasChanges - Whether changes were detected
 * @param inactivityDuration - Duration in milliseconds since last change
 * @returns Next update interval to use
 */
function getNextUpdateInterval(hasChanges: boolean, inactivityDuration: number): number {
	if (hasChanges) {
		return UPDATE_INTERVALS.FAST;
	}

	if (inactivityDuration < TIME_CONSTANTS.FIVE_MINUTES_MS) {
		return UPDATE_INTERVALS.FAST;
	}

	if (inactivityDuration < TIME_CONSTANTS.TEN_MINUTES_MS) {
		return UPDATE_INTERVALS.MEDIUM;
	}

	return UPDATE_INTERVALS.SLOW;
}

/**
 * Displays the active block information with progress bars
 * @param block - Active session block
 * @param allBlocks - All blocks for burn rate analysis
 * @param options - Display options
 */
function displayActiveBlock(block: SessionBlock, allBlocks: SessionBlock[], options: DisplayOptions = { showPeriod: false, showTokens: false, showCost: false }): void {
	const now = new Date();
	const remaining = Math.round((block.endTime.getTime() - now.getTime()) / (1000 * 60));

	const burnRate = calculateBurnRate(block);
	const projection = projectBlockUsage(block);
	const burnRateAnalysis = calculateBurnRateAnalysis(block);

	const currentTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;

	// Time remaining progress bar (countdown style - starts full, decreases over time)
	let timeColor = pc.green; // default green
	if (remaining <= TIME_WARNING_THRESHOLDS.CRITICAL) {
		timeColor = pc.red; // red when critical threshold reached
	}
	else if (remaining <= TIME_WARNING_THRESHOLDS.WARNING) {
		timeColor = pc.yellow; // yellow when warning threshold reached
	}

	const timeProgress = createProgressBar(
		BLOCK_DURATION_MINUTES - remaining, // elapsed time (starts at 0, increases to 300)
		BLOCK_DURATION_MINUTES, // 5 hours in minutes
		{
			complete: pc.gray,
			incomplete: timeColor,
		},
	);
	log(`Time Remaining: ${timeProgress} ${formatDuration(remaining)} (Reset on ${block.endTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })})`);

	// Calculate model breakdown
	const { modelCosts } = calculateModelBreakdown(block.entries);

	const totalUsedCost = Array.from(modelCosts.values()).reduce((sum, cost) => sum + cost, 0);

	// Calculate maximum cost from historical blocks
	let maxCostFromHistory = 0;
	for (const historicalBlock of allBlocks) {
		if (!(historicalBlock.isGap ?? false) && !historicalBlock.isActive) {
			if (historicalBlock.costUSD > maxCostFromHistory) {
				maxCostFromHistory = historicalBlock.costUSD;
			}
		}
	}

	// Determine the maximum cost value for the progress bar
	let maxCost: number;
	if (maxCostFromHistory > 0) {
		// Use the max cost from historical blocks
		maxCost = maxCostFromHistory;
	}
	else if (projection != null) {
		// Use projected total cost
		maxCost = projection.totalCost;
	}
	else {
		// Use a reasonable scale based on current usage
		maxCost = Math.max(totalUsedCost * 10, 1.0); // Scale to show meaningful progress
	}

	// Display cost progress bar and legend
	displayCostProgressBar(modelCosts, maxCost, projection);

	// Current statistics - show tokens with projection
	const currentTokensStr = formatNumber(currentTokens);
	const currentCostStr = formatCurrency(block.costUSD);

	// Calculate the width needed for alignment
	const maxCurrentWidth = Math.max(currentTokensStr.length, currentCostStr.length);

	let projectedTokensText = '';
	if (projection != null) {
		projectedTokensText = ` (Est. ${formatNumber(projection.totalTokens)})`;
	}

	// Calculate projected cost
	let projectedCostText = '';
	if (burnRate != null) {
		const remainingMinutes = Math.max(0, (block.endTime.getTime() - now.getTime()) / (1000 * 60));
		const projectedCostAtEnd = block.costUSD + (burnRate.costPerHour * (remainingMinutes / 60));
		projectedCostText = ` (Est. ${formatCurrency(projectedCostAtEnd)})`;
	}
	else if (projection != null) {
		projectedCostText = ` (Est. ${formatCurrency(projection.totalCost)})`;
	}

	// Pad the current values to align the Est. values
	log(`Tokens:  ${currentTokensStr.padEnd(maxCurrentWidth)}${projectedTokensText}`);
	log(`Cost:    ${currentCostStr.padEnd(maxCurrentWidth)}${projectedCostText}`);

	// Show optional tables based on display options
	if (options.showTokens) {
		log('');
		log(displayTokensTable(block));
	}

	if (options.showCost) {
		log('');
		log(displayCostTable(block));
	}

	if (options.showPeriod) {
		log('');
		log(displayPeriodTable(burnRateAnalysis));
	}
	log('');

	// Status line with smooth sailing or warnings
	const currentTime = now.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	log(`${currentTime} | Tokens (T) | Cost (C) | Period (P) | Exit (Esc)`);
}

/**
 * Creates a cleanup handler function for the watch command
 * @param intervalId - Reference object containing the timer interval ID to clear
 * @param intervalId.current - The actual timer interval ID
 * @param sessionStartTime - When the session started
 * @param sessionStartTokens - Initial token count
 * @param sessionStartCost - Initial cost
 * @param activeBlockForSummary - Reference to active block for summary
 * @param activeBlockForSummary.current - The actual active block
 * @returns Cleanup function
 */
function createCleanupHandler(
	intervalId: { current: NodeJS.Timeout | null },
	sessionStartTime: Date,
	sessionStartTokens: number,
	sessionStartCost: number,
	activeBlockForSummary: { current: SessionBlock | null },
): () => void {
	return (): void => {
		if (intervalId.current != null) {
			clearTimeout(intervalId.current);
		}
		process.stdin.setRawMode(false);
		process.stdin.pause();
		clearScreen();

		// Calculate session duration
		const sessionEndTime = new Date();
		const durationMs = sessionEndTime.getTime() - sessionStartTime.getTime();
		const durationMinutes = Math.floor(durationMs / (1000 * 60));
		const durationSeconds = Math.floor(durationMs / 1000);

		const durationText = formatDuration(durationMinutes, durationSeconds);

		// Calculate tokens and cost used during this session
		let tokensUsed = 0;
		let costUsed = 0;

		if (activeBlockForSummary.current != null) {
			const currentTokens = activeBlockForSummary.current.tokenCounts.inputTokens + activeBlockForSummary.current.tokenCounts.outputTokens;
			tokensUsed = currentTokens - sessionStartTokens;
			costUsed = activeBlockForSummary.current.costUSD - sessionStartCost;
		}

		log(pc.cyan(`Duration: ${durationText} | Tokens: ${formatNumber(tokensUsed)} | Cost: ${formatCurrency(costUsed)}`));
		process.exit(0);
	};
}

/**
 * Sets up keyboard input handling for the watch command
 * @param displayOptions - Display options that can be toggled
 * @param updateDisplay - Function to call when display needs updating
 * @param cleanup - Cleanup function to call on exit
 */
function setupKeyboardHandling(
	displayOptions: DisplayOptions,
	updateDisplay: () => Promise<void>,
	cleanup: () => void,
): void {
	// Setup keyboard input handling
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding('utf8');

	// Handle keyboard input
	const handleKeyPress = (key: string): void => {
		// Exit keys
		if (key === '\u001B' || key === '\u0003') { // ESC or Ctrl+C
			cleanup();
			return;
		}

		// Toggle display options
		const keyLower = key.toLowerCase();
		let needsUpdate = false;

		if (keyLower === 'p') {
			displayOptions.showPeriod = !displayOptions.showPeriod;
			needsUpdate = true;
		}
		else if (keyLower === 't') {
			displayOptions.showTokens = !displayOptions.showTokens;
			needsUpdate = true;
		}
		else if (keyLower === 'c') {
			displayOptions.showCost = !displayOptions.showCost;
			needsUpdate = true;
		}

		if (needsUpdate) {
			updateDisplay().catch((error: unknown) => {
				console.error('Update display error:', error);
			});
		}
	};

	process.stdin.on('data', handleKeyPress);

	// Handle Ctrl+C gracefully (fallback)
	process.on('SIGINT', cleanup);
}

/**
 * Configuration for the update display function
 */
type UpdateDisplayConfig = {
	since?: string;
	until?: string;
	mode: 'auto' | 'calculate' | 'display';
	order?: 'asc' | 'desc';
	sessionLength?: number;
};

/**
 * State management for the update display function
 */
type UpdateDisplayState = {
	previousState: { current: BlockState | null };
	currentInterval: { current: number };
	lastChangeTime: { current: Date };
	sessionTracker: SessionTracker;
	activeBlockForSummary: { current: SessionBlock | null };
};

/**
 * Creates the main update display function
 * @param config - Configuration for data loading
 * @param state - State management objects
 * @param displayOptions - Display options that can be toggled
 * @returns Update display function
 */
function createUpdateDisplay(
	config: UpdateDisplayConfig,
	state: UpdateDisplayState,
	displayOptions: DisplayOptions,
): () => Promise<void> {
	return async (): Promise<void> => {
		try {
			// Load active block
			const blocks = await loadSessionBlockData({
				since: config.since,
				until: config.until,
				claudePath: getDefaultClaudePath(),
				mode: config.mode,
				order: config.order,
				sessionDurationHours: config.sessionLength,
			});

			const activeBlocks = blocks.filter((block: SessionBlock) => block.isActive);

			if (activeBlocks.length === 0) {
				clearScreen();
				log(pc.yellow('ℹ No active session block found.'));
				log('');
				log(`${new Date().toLocaleTimeString()} | Exit (Esc)`);
				return;
			}

			const activeBlock = activeBlocks[0];
			if (activeBlock == null) {
				return;
			}

			// Track the active block for session summary
			state.activeBlockForSummary.current = activeBlock;

			// Initialize session start values if this is the first update
			const currentTokens = activeBlock.tokenCounts.inputTokens + activeBlock.tokenCounts.outputTokens;
			state.sessionTracker.setStartValues(currentTokens, activeBlock.costUSD);

			// Create current state
			const burnRate = calculateBurnRate(activeBlock);
			const now = new Date();
			const currentState: BlockState = {
				tokenCount: currentTokens,
				costUSD: activeBlock.costUSD,
				burnRate: burnRate?.tokensPerMinute ?? null,
				lastUpdate: now,
				lastChangeTime: state.lastChangeTime.current,
			};

			// Check for changes and update timing
			const hasChanges = hasSignificantChanges(currentState, state.previousState.current);
			if (hasChanges) {
				state.lastChangeTime.current = now;
				currentState.lastChangeTime = state.lastChangeTime.current;
			}

			// Update interval based on inactivity
			const inactivityDuration = now.getTime() - state.lastChangeTime.current.getTime();
			state.currentInterval.current = getNextUpdateInterval(hasChanges, inactivityDuration);

			// Clear screen and display
			clearScreen();
			displayActiveBlock(activeBlock, blocks, displayOptions);

			// Update previous state
			state.previousState.current = currentState;
		}
		catch (error) {
			clearScreen();
			log(pc.red('Error loading usage data:'));
			log(pc.gray(`   ${error instanceof Error ? error.message : String(error)}`));
			log('');
			log(`${new Date().toLocaleTimeString()} | Exit (Esc)`);
		}
	};
}

export const watchCommand = define({
	name: 'watch',
	description: 'Watch active session block usage with real-time updates and progress bars',
	args: {
		...sharedCommandConfig.args,
		sessionLength: {
			type: 'number',
			short: 'l',
			description: `Session block duration in hours (default: ${DEFAULT_SESSION_DURATION_HOURS})`,
			default: DEFAULT_SESSION_DURATION_HOURS,
		},
	},
	toKebab: true,
	async run(ctx) {
		// Force silent logger for clean display
		logger.level = 0;

		// Default to 'auto' mode for cached pricing
		const mode = ctx.values.mode ?? 'auto';

		// Validate session length
		if (ctx.values.sessionLength != null && ctx.values.sessionLength <= 0) {
			console.error('Session length must be a positive number');
			process.exit(1);
		}

		// Setup state management
		const intervalId = { current: null as NodeJS.Timeout | null };
		const displayOptions: DisplayOptions = { showPeriod: false, showTokens: false, showCost: false };
		const sessionStartTime = new Date();
		const sessionTracker = createSessionTracker();

		// State for update display function
		const state: UpdateDisplayState = {
			previousState: { current: null },
			currentInterval: { current: UPDATE_INTERVALS.FAST },
			lastChangeTime: { current: new Date() },
			sessionTracker,
			activeBlockForSummary: { current: null },
		};

		// Configuration for update display function
		const config: UpdateDisplayConfig = {
			since: ctx.values.since,
			until: ctx.values.until,
			mode,
			order: ctx.values.order,
			sessionLength: ctx.values.sessionLength,
		};

		// Create update display function
		const updateDisplay = createUpdateDisplay(config, state, displayOptions);

		// Initial display
		await updateDisplay();

		// Setup interval with adaptive timing
		const scheduleNext = (): void => {
			intervalId.current = setTimeout(() => {
				updateDisplay().then(() => {
					scheduleNext();
				}).catch((error: unknown) => {
					console.error('Update display error:', error);
				});
			}, state.currentInterval.current);
		};

		scheduleNext();

		// Create cleanup handler and setup keyboard handling
		const cleanup = createCleanupHandler(
			intervalId,
			sessionStartTime,
			sessionTracker.startTokens,
			sessionTracker.startCost,
			state.activeBlockForSummary,
		);

		setupKeyboardHandling(displayOptions, updateDisplay, cleanup);
	},
});
