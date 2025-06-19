import process from 'node:process';
import Table from 'cli-table3';
import { define } from 'gunshi';
import pc from 'picocolors';
import { getDefaultClaudePath, loadSessionBlockData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';
import {
	calculateBurnRate,
	DEFAULT_SESSION_DURATION_HOURS,
	type LoadedUsageEntry,
	projectBlockUsage,
	type SessionBlock,
} from '../session-blocks.internal.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import { formatCurrency, formatModelsDisplay, formatNumber } from '../utils.internal.ts';

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
 * Display options for watch mode
 */
type DisplayOptions = {
	showPeriod: boolean;
	showTokens: boolean;
	showCost: boolean;
};

/**
 * Represents burn rate calculations for different time periods
 */
type BurnRateAnalysis = {
	block: { input: number | null; output: number | null; cacheCreate: number | null; cacheRead: number | null };
	oneHour: { input: number | null; output: number | null; cacheCreate: number | null; cacheRead: number | null };
	tenMinutes: { input: number | null; output: number | null; cacheCreate: number | null; cacheRead: number | null };
};

/**
 * Model types for categorization
 */
type ModelType = 'opus' | 'sonnet' | 'haiku';

/**
 * Constants for progress bars and timing
 */
const PROGRESS_BAR_WIDTH = 40;
const BLOCK_DURATION_MINUTES = DEFAULT_SESSION_DURATION_HOURS * 60;

/**
 * Time warning thresholds in minutes
 */
const TIME_WARNING_THRESHOLDS = {
	CRITICAL: 30, // Red warning when 30 minutes or less remaining
	WARNING: 60, // Yellow warning when 1 hour or less remaining
};

/**
 * Gets the model type from a model name
 */
function getModelType(model: string): ModelType | null {
	if (model.includes('opus')) {
		return 'opus';
	}
	if (model.includes('sonnet')) {
		return 'sonnet';
	}
	if (model.includes('haiku')) {
		return 'haiku';
	}
	return null;
}

/**
 * Calculates model breakdown data from block entries using actual model names
 */
function calculateModelBreakdown(entries: LoadedUsageEntry[]): {
	modelTokens: Map<string, number>;
	modelCosts: Map<string, number>;
} {
	const modelTokens = new Map<string, number>();
	const modelCosts = new Map<string, number>();

	for (const entry of entries) {
		const modelName = entry.model;

		const currentTokens = modelTokens.get(modelName) ?? 0;
		const entryTokens = entry.usage.inputTokens + entry.usage.outputTokens;
		modelTokens.set(modelName, currentTokens + entryTokens);

		const currentCost = modelCosts.get(modelName) ?? 0;
		const entryCost = entry.costUSD ?? 0;
		modelCosts.set(modelName, currentCost + entryCost);
	}

	return { modelTokens, modelCosts };
}

/**
 * Creates and displays the combined progress bar for models grouped by type
 */
function displayCostProgressBar(
	modelCosts: Map<string, number>,
	maxCost: number,
	projection: { totalCost: number } | null,
): void {
	// Group costs by model type
	let opusCost = 0;
	let sonnetCost = 0;
	let haikuCost = 0;

	for (const [modelName, cost] of modelCosts.entries()) {
		const modelType = getModelType(modelName);
		if (modelType != null) {
			switch (modelType) {
				case 'opus':
					opusCost += cost;
					break;
				case 'sonnet':
					sonnetCost += cost;
					break;
				case 'haiku':
					haikuCost += cost;
					break;
			}
		}
	}
	const totalUsedCost = opusCost + sonnetCost + haikuCost;

	// Calculate percentages, capping at 1.0 for display purposes
	const totalPercentage = Math.min(totalUsedCost / maxCost, 1.0);
	const opusPercentage = totalUsedCost > 0 ? opusCost / totalUsedCost : 0;
	const sonnetPercentage = totalUsedCost > 0 ? sonnetCost / totalUsedCost : 0;
	const haikuPercentage = totalUsedCost > 0 ? haikuCost / totalUsedCost : 0;

	// Calculate widths based on the actual usage up to 100%
	const usedWidth = Math.round(totalPercentage * PROGRESS_BAR_WIDTH);

	// Distribute the used width proportionally among models
	let opusWidth = 0;
	let sonnetWidth = 0;
	let haikuWidth = 0;

	if (usedWidth > 0 && totalUsedCost > 0) {
		// Calculate proportional widths
		opusWidth = opusCost > 0 ? Math.max(1, Math.round(opusPercentage * usedWidth)) : 0;
		sonnetWidth = sonnetCost > 0 ? Math.max(1, Math.round(sonnetPercentage * usedWidth)) : 0;
		haikuWidth = haikuCost > 0 ? Math.max(1, Math.round(haikuPercentage * usedWidth)) : 0;

		// Adjust if total exceeds usedWidth due to rounding
		const totalModelWidth = opusWidth + sonnetWidth + haikuWidth;
		if (totalModelWidth > usedWidth) {
			// Reduce the largest width
			if (opusWidth >= sonnetWidth && opusWidth >= haikuWidth && opusWidth > 1) {
				opusWidth -= (totalModelWidth - usedWidth);
			}
			else if (sonnetWidth >= haikuWidth && sonnetWidth > 1) {
				sonnetWidth -= (totalModelWidth - usedWidth);
			}
			else if (haikuWidth > 1) {
				haikuWidth -= (totalModelWidth - usedWidth);
			}
		}

		// Ensure we don't have negative widths
		opusWidth = Math.max(0, opusWidth);
		sonnetWidth = Math.max(0, sonnetWidth);
		haikuWidth = Math.max(0, haikuWidth);
	}

	const totalModelWidth = opusWidth + sonnetWidth + haikuWidth;
	const emptyWidth = Math.max(0, PROGRESS_BAR_WIDTH - totalModelWidth);

	// Build the progress bar with colors
	const opusBar = pc.blue('■'.repeat(opusWidth));
	const sonnetBar = pc.cyan('■'.repeat(sonnetWidth));
	const haikuBar = pc.magenta('■'.repeat(haikuWidth));
	const emptyBar = pc.gray('■'.repeat(emptyWidth));

	const combinedProgress = `[${opusBar}${sonnetBar}${haikuBar}${emptyBar}]`;

	// Calculate percentages and projections based on cost
	const totalPercentageText = ((totalUsedCost / maxCost) * 100).toFixed(1);

	let projectedPercentageText = '';
	if (projection != null) {
		const projectedPercentage = (projection.totalCost / maxCost) * 100;
		const projectedPercentageStr = projectedPercentage.toFixed(1);
		if (projectedPercentage > 100) {
			projectedPercentageText = ` (Est. ${pc.red(`${projectedPercentageStr}%`)})`;
		}
		else {
			projectedPercentageText = ` (Est. ${projectedPercentageStr}%)`;
		}
	}

	// Display the combined progress bar
	log(`Cost Usage:     ${combinedProgress} ${totalPercentageText}%${projectedPercentageText}`);

	// Show legend - only display models that have been used (based on cost)
	const legendItems = [];
	if (opusCost > 0) {
		const opusPercentageDisplay = ((opusCost / maxCost) * 100).toFixed(1);
		legendItems.push(`${pc.blue('■')} opus ${opusPercentageDisplay}%`);
	}
	if (sonnetCost > 0) {
		const sonnetPercentageDisplay = ((sonnetCost / maxCost) * 100).toFixed(1);
		legendItems.push(`${pc.cyan('■')} sonnet ${sonnetPercentageDisplay}%`);
	}
	if (haikuCost > 0) {
		const haikuPercentageDisplay = ((haikuCost / maxCost) * 100).toFixed(1);
		legendItems.push(`${pc.magenta('■')} haiku ${haikuPercentageDisplay}%`);
	}
	legendItems.push(`${pc.gray('■')} Unused`);
	log(`   ${legendItems.join('  ')}`);
	log('');
}

/**
 * Displays tokens breakdown table if enabled
 */
function displayTokensTable(block: SessionBlock): void {
	const table = new Table({
		head: ['Tokens', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total'],
		style: { head: ['cyan'] },
		colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
	});

	// Calculate token breakdown by actual model name
	const modelBreakdown = new Map<string, { input: number; output: number; cacheCreate: number; cacheRead: number }>();

	for (const entry of block.entries) {
		const modelName = entry.model;

		const current = modelBreakdown.get(modelName) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
		modelBreakdown.set(modelName, {
			input: current.input + entry.usage.inputTokens,
			output: current.output + entry.usage.outputTokens,
			cacheCreate: current.cacheCreate + entry.usage.cacheCreationInputTokens,
			cacheRead: current.cacheRead + entry.usage.cacheReadInputTokens,
		});
	}

	// Add rows for each model that has usage
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheCreate = 0;
	let totalCacheRead = 0;

	// Sort models by name for consistent display
	const sortedModels = Array.from(modelBreakdown.entries()).sort(([a], [b]) => a.localeCompare(b));

	for (const [modelName, tokens] of sortedModels) {
		if (tokens.input > 0 || tokens.output > 0 || tokens.cacheCreate > 0 || tokens.cacheRead > 0) {
			const total = tokens.input + tokens.output + tokens.cacheCreate + tokens.cacheRead;
			const displayName = formatModelsDisplay([modelName]);
			table.push([
				displayName,
				formatNumber(tokens.input),
				formatNumber(tokens.output),
				formatNumber(tokens.cacheCreate),
				formatNumber(tokens.cacheRead),
				formatNumber(total),
			]);
			totalInput += tokens.input;
			totalOutput += tokens.output;
			totalCacheCreate += tokens.cacheCreate;
			totalCacheRead += tokens.cacheRead;
		}
	}

	// Add total row
	if (modelBreakdown.size > 1) {
		table.push([
			pc.bold('Total'),
			pc.bold(formatNumber(totalInput)),
			pc.bold(formatNumber(totalOutput)),
			pc.bold(formatNumber(totalCacheCreate)),
			pc.bold(formatNumber(totalCacheRead)),
			pc.bold(formatNumber(totalInput + totalOutput + totalCacheCreate + totalCacheRead)),
		]);
	}

	log(table.toString());
}

/**
 * Displays cost breakdown table if enabled
 */
function displayCostTable(block: SessionBlock): void {
	const table = new Table({
		head: ['Cost', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total'],
		style: { head: ['cyan'] },
		colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
	});

	// Calculate cost breakdown by actual model name
	const modelCostBreakdown = new Map<string, { input: number; output: number; cacheCreate: number; cacheRead: number }>();

	for (const entry of block.entries) {
		const modelName = entry.model;

		const current = modelCostBreakdown.get(modelName) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

		// Calculate individual cost components
		// We need to estimate the cost breakdown since we only have total costUSD
		const totalTokens = entry.usage.inputTokens + entry.usage.outputTokens + entry.usage.cacheCreationInputTokens + entry.usage.cacheReadInputTokens;
		if (totalTokens > 0 && entry.costUSD != null && entry.costUSD > 0) {
			const costPerToken = entry.costUSD / totalTokens;
			modelCostBreakdown.set(modelName, {
				input: current.input + (entry.usage.inputTokens * costPerToken),
				output: current.output + (entry.usage.outputTokens * costPerToken),
				cacheCreate: current.cacheCreate + (entry.usage.cacheCreationInputTokens * costPerToken),
				cacheRead: current.cacheRead + (entry.usage.cacheReadInputTokens * costPerToken),
			});
		}
	}

	// Add rows for each model that has usage
	let totalInputCost = 0;
	let totalOutputCost = 0;
	let totalCacheCreateCost = 0;
	let totalCacheReadCost = 0;

	// Sort models by name for consistent display
	const sortedModels = Array.from(modelCostBreakdown.entries()).sort(([a], [b]) => a.localeCompare(b));

	for (const [modelName, costs] of sortedModels) {
		const totalCost = costs.input + costs.output + costs.cacheCreate + costs.cacheRead;
		if (totalCost > 0) {
			const displayName = formatModelsDisplay([modelName]);
			table.push([
				displayName,
				formatCurrency(costs.input),
				formatCurrency(costs.output),
				formatCurrency(costs.cacheCreate),
				formatCurrency(costs.cacheRead),
				formatCurrency(totalCost),
			]);
			totalInputCost += costs.input;
			totalOutputCost += costs.output;
			totalCacheCreateCost += costs.cacheCreate;
			totalCacheReadCost += costs.cacheRead;
		}
	}

	// Add total row
	if (modelCostBreakdown.size > 1) {
		table.push([
			pc.bold('Total'),
			pc.bold(formatCurrency(totalInputCost)),
			pc.bold(formatCurrency(totalOutputCost)),
			pc.bold(formatCurrency(totalCacheCreateCost)),
			pc.bold(formatCurrency(totalCacheReadCost)),
			pc.bold(formatCurrency(totalInputCost + totalOutputCost + totalCacheCreateCost + totalCacheReadCost)),
		]);
	}

	log(table.toString());
}

/**
 * Displays period burn rate table if enabled
 */
function displayPeriodTable(burnRateAnalysis: BurnRateAnalysis): void {
	const table = new Table({
		head: ['Period', 'Input t/min', 'Output t/min', 'Cache Create t/min', 'Cache Read t/min'],
		style: { head: ['cyan'] },
		colAligns: ['left', 'right', 'right', 'right', 'right'],
	});

	const formatRate = (rate: number | null): string => {
		return rate != null ? formatNumber(Math.round(rate)) : 'N/A';
	};

	table.push(
		['Block', formatRate(burnRateAnalysis.block.input), formatRate(burnRateAnalysis.block.output), formatRate(burnRateAnalysis.block.cacheCreate), formatRate(burnRateAnalysis.block.cacheRead)],
		['1 Hour', formatRate(burnRateAnalysis.oneHour.input), formatRate(burnRateAnalysis.oneHour.output), formatRate(burnRateAnalysis.oneHour.cacheCreate), formatRate(burnRateAnalysis.oneHour.cacheRead)],
		['10 Minutes', formatRate(burnRateAnalysis.tenMinutes.input), formatRate(burnRateAnalysis.tenMinutes.output), formatRate(burnRateAnalysis.tenMinutes.cacheCreate), formatRate(burnRateAnalysis.tenMinutes.cacheRead)],
	);

	log(table.toString());
}

/**
 * Time constants for intervals
 */
const TIME_CONSTANTS = {
	FIVE_MINUTES_MS: 5 * 60 * 1000,
	TEN_MINUTES_MS: 10 * 60 * 1000,
	ONE_HOUR_MS: 60 * 60 * 1000,
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
 * Creates a progress bar string with the given parameters
 * @param current - Current value
 * @param max - Maximum value
 * @param style - Style configuration for colors
 * @param style.complete - Function to style completed portion
 * @param style.incomplete - Function to style incomplete portion
 * @param style.warning - Optional function to style warning state
 * @param style.warningThreshold - Optional threshold for warning state (0-1)
 * @returns Formatted progress bar string
 */
function createProgressBar(
	current: number,
	max: number,
	style: {
		complete: (str: string) => string;
		incomplete: (str: string) => string;
		warning?: (str: string) => string;
		warningThreshold?: number;
	} = { complete: pc.green, incomplete: pc.red },
): string {
	const percentage = Math.min(current / max, 1);
	const filledWidth = Math.floor(percentage * PROGRESS_BAR_WIDTH);
	const emptyWidth = PROGRESS_BAR_WIDTH - filledWidth;

	const isWarning = style.warningThreshold != null && percentage >= style.warningThreshold;
	const completeColor = isWarning && style.warning != null ? style.warning : style.complete;

	const filled = '■'.repeat(filledWidth);
	const empty = '■'.repeat(emptyWidth);

	return `[${completeColor(filled)}${style.incomplete(empty)}]`;
}

/**
 * Clears the terminal and moves cursor to top
 */
function clearScreen(): void {
	process.stdout.write('\x1B[2J\x1B[0f');
}

/**
 * Formats time duration in hours and minutes
 * @param minutes - Duration in minutes
 * @returns Formatted time string
 */
function formatDuration(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	if (hours > 0) {
		return `${hours}h ${mins}m`;
	}
	return `${mins}m`;
}

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
 * Calculates burn rate analysis for different time periods
 * @param block - Current session block
 * @param _allBlocks - All blocks for historical comparison
 * @returns Burn rate analysis object
 */
function calculateBurnRateAnalysis(block: SessionBlock, _allBlocks: SessionBlock[]): BurnRateAnalysis {
	const now = new Date();
	const oneHourAgo = new Date(now.getTime() - TIME_CONSTANTS.ONE_HOUR_MS);
	const tenMinutesAgo = new Date(now.getTime() - TIME_CONSTANTS.TEN_MINUTES_MS);

	// Get entries from different time periods
	const lastHourEntries = block.entries.filter(entry => entry.timestamp >= oneHourAgo);
	const lastTenMinutesEntries = block.entries.filter(entry => entry.timestamp >= tenMinutesAgo);

	// Calculate burn rates for different periods
	const oneHourRate = calculatePeriodBurnRate(lastHourEntries);
	const tenMinutesRate = calculatePeriodBurnRate(lastTenMinutesEntries);

	// Calculate block rate from all entries
	const blockRate = calculatePeriodBurnRate(block.entries);

	return {
		block: blockRate,
		oneHour: oneHourRate,
		tenMinutes: tenMinutesRate,
	};
}

/**
 * Calculates burn rate for a specific set of entries
 * @param entries - Usage entries to analyze
 * @returns Burn rate in tokens per minute for input, output, cache create, and cache read separately
 */
function calculatePeriodBurnRate(entries: LoadedUsageEntry[]): { input: number | null; output: number | null; cacheCreate: number | null; cacheRead: number | null } {
	const nullResult = { input: null, output: null, cacheCreate: null, cacheRead: null };

	if (entries.length === 0) {
		return nullResult;
	}

	// Sort entries by timestamp to ensure correct order
	const sortedEntries = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

	if (sortedEntries.length < 2) {
		return nullResult;
	}

	const firstEntry = sortedEntries[0];
	const lastEntry = sortedEntries[sortedEntries.length - 1];
	if (firstEntry == null || lastEntry == null) {
		return nullResult;
	}

	const durationMinutes = (lastEntry.timestamp.getTime() - firstEntry.timestamp.getTime()) / (1000 * 60);
	if (durationMinutes <= 0) {
		return nullResult;
	}

	// Calculate total tokens used in this period
	const totalInputTokens = sortedEntries.reduce((sum, entry) => sum + entry.usage.inputTokens, 0);
	const totalOutputTokens = sortedEntries.reduce((sum, entry) => sum + entry.usage.outputTokens, 0);
	const totalCacheCreateTokens = sortedEntries.reduce((sum, entry) => sum + entry.usage.cacheCreationInputTokens, 0);
	const totalCacheReadTokens = sortedEntries.reduce((sum, entry) => sum + entry.usage.cacheReadInputTokens, 0);

	return {
		input: totalInputTokens / durationMinutes,
		output: totalOutputTokens / durationMinutes,
		cacheCreate: totalCacheCreateTokens / durationMinutes,
		cacheRead: totalCacheReadTokens / durationMinutes,
	};
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
	const burnRateAnalysis = calculateBurnRateAnalysis(block, allBlocks);

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
		displayTokensTable(block);
	}

	if (options.showCost) {
		log('');
		displayCostTable(block);
	}

	if (options.showPeriod) {
		log('');
		displayPeriodTable(burnRateAnalysis);
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

		let previousState: BlockState | null = null;
		let currentInterval = UPDATE_INTERVALS.FAST;
		let intervalId: NodeJS.Timeout;
		let lastChangeTime = new Date();
		const displayOptions: DisplayOptions = { showPeriod: false, showTokens: false, showCost: false };

		// Track start time and initial values for session summary
		const sessionStartTime = new Date();
		let sessionStartTokens = 0;
		let sessionStartCost = 0;
		let activeBlockForSummary: SessionBlock | null = null;

		// Main update function
		const updateDisplay = async (): Promise<void> => {
			try {
				// Load active block
				const blocks = await loadSessionBlockData({
					since: ctx.values.since,
					until: ctx.values.until,
					claudePath: getDefaultClaudePath(),
					mode,
					order: ctx.values.order,
					sessionDurationHours: ctx.values.sessionLength,
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
				activeBlockForSummary = activeBlock;

				// Initialize session start values if this is the first update
				if (sessionStartTokens === 0 && sessionStartCost === 0) {
					sessionStartTokens = activeBlock.tokenCounts.inputTokens + activeBlock.tokenCounts.outputTokens;
					sessionStartCost = activeBlock.costUSD;
				}

				// Create current state
				const currentTokens = activeBlock.tokenCounts.inputTokens + activeBlock.tokenCounts.outputTokens;
				const burnRate = calculateBurnRate(activeBlock);
				const now = new Date();
				const currentState: BlockState = {
					tokenCount: currentTokens,
					costUSD: activeBlock.costUSD,
					burnRate: burnRate?.tokensPerMinute ?? null,
					lastUpdate: now,
					lastChangeTime,
				};

				// Check for changes and update timing
				const hasChanges = hasSignificantChanges(currentState, previousState);
				if (hasChanges) {
					lastChangeTime = now;
					currentState.lastChangeTime = lastChangeTime;
				}

				// Update interval based on inactivity
				const inactivityDuration = now.getTime() - lastChangeTime.getTime();
				currentInterval = getNextUpdateInterval(hasChanges, inactivityDuration);

				// Clear screen and display
				clearScreen();
				displayActiveBlock(activeBlock, blocks, displayOptions);

				// Update previous state
				previousState = currentState;
			}
			catch (error) {
				clearScreen();
				log(pc.red('Error loading usage data:'));
				log(pc.gray(`   ${error instanceof Error ? error.message : String(error)}`));
				log('');
				log(`${new Date().toLocaleTimeString()} | Exit (Esc)`);
			}
		};

		// Initial display
		await updateDisplay();

		// Setup interval with adaptive timing
		const scheduleNext = (): void => {
			intervalId = setTimeout(() => {
				updateDisplay().then(() => {
					scheduleNext();
				}).catch((error) => {
					console.error('Update display error:', error);
				});
			}, currentInterval);
		};

		scheduleNext();

		// Setup keyboard input handling
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		const cleanup = (): void => {
			clearTimeout(intervalId);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			clearScreen();

			// Calculate session duration
			const sessionEndTime = new Date();
			const durationMs = sessionEndTime.getTime() - sessionStartTime.getTime();
			const durationMinutes = Math.floor(durationMs / (1000 * 60));
			const durationSeconds = Math.floor((durationMs % (1000 * 60)) / 1000);

			let durationText = '';
			if (durationMinutes > 0) {
				durationText = `${durationMinutes}m ${durationSeconds}s`;
			}
			else {
				durationText = `${durationSeconds}s`;
			}

			// Calculate tokens and cost used during this session
			let tokensUsed = 0;
			let costUsed = 0;

			if (activeBlockForSummary != null) {
				const currentTokens = activeBlockForSummary.tokenCounts.inputTokens + activeBlockForSummary.tokenCounts.outputTokens;
				tokensUsed = currentTokens - sessionStartTokens;
				costUsed = activeBlockForSummary.costUSD - sessionStartCost;
			}

			log(pc.cyan(`Duration: ${durationText} | Tokens: ${formatNumber(tokensUsed)} | Cost: ${formatCurrency(costUsed)}`));
			process.exit(0);
		};

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
				updateDisplay().catch((error) => {
					console.error('Update display error:', error);
				});
			}
		};

		process.stdin.on('data', handleKeyPress);

		// Handle Ctrl+C gracefully (fallback)
		process.on('SIGINT', cleanup);
	},
});
