import { uniq } from 'es-toolkit';
import { DEFAULT_RECENT_DAYS } from './_consts.ts';

/**
 * Default session duration in hours (Claude's billing block duration)
 */
export const DEFAULT_SESSION_DURATION_HOURS = 5;

/**
 * Floors a timestamp to the beginning of the hour in UTC
 * @param timestamp - The timestamp to floor
 * @returns New Date object floored to the UTC hour
 */
function floorToHour(timestamp: Date): Date {
	const floored = new Date(timestamp);
	floored.setUTCMinutes(0, 0, 0);
	return floored;
}

/**
 * Represents a single usage data entry loaded from JSONL files
 */
export type LoadedUsageEntry = {
	timestamp: Date;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	costUSD: number | null;
	model: string;
	version?: string;
};

/**
 * Aggregated token counts for different token types
 */
type TokenCounts = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
};

/**
 * Represents a session block (typically 5-hour billing period) with usage data
 */
export type SessionBlock = {
	id: string; // ISO string of block start time
	startTime: Date;
	endTime: Date; // startTime + 5 hours (for normal blocks) or gap end time (for gap blocks)
	actualEndTime?: Date; // Last activity in block
	isActive: boolean;
	isGap?: boolean; // True if this is a gap block
	entries: LoadedUsageEntry[];
	tokenCounts: TokenCounts;
	costUSD: number;
	models: string[];
};

/**
 * Represents per-model cost and token breakdown within a session block
 */
export type PerModelBreakdown = {
	[modelName: string]: {
		costUSD: number;
		totalTokens: number;
		entries: number;
	};
};

/**
 * Represents historical values for ranking (2nd-max, 3rd-max, etc.)
 */
export type PerModelHistoricalValues = {
	[modelName: string]: {
		costUSD: number[];
		totalTokens: number[];
		entries: number[];
	};
};

/**
 * Represents usage burn rate calculations
 */
type BurnRate = {
	tokensPerMinute: number;
	costPerHour: number;
	/**
	 * Activity density ratio (0-1) indicating how much of the time period
	 * the model was actually active. Used to adjust projections for sparse usage.
	 */
	activityDensity?: number;
};

/**
 * Represents projected usage for remaining time in a session block
 */
type ProjectedUsage = {
	totalTokens: number;
	totalCost: number;
	remainingMinutes: number;
};

/**
 * Identifies and creates session blocks from usage entries
 * Groups entries into time-based blocks (typically 5-hour periods) with gap detection
 * @param entries - Array of usage entries to process
 * @param sessionDurationHours - Duration of each session block in hours
 * @returns Array of session blocks with aggregated usage data
 */
export function identifySessionBlocks(
	entries: LoadedUsageEntry[],
	sessionDurationHours = DEFAULT_SESSION_DURATION_HOURS,
): SessionBlock[] {
	if (entries.length === 0) {
		return [];
	}

	const sessionDurationMs = sessionDurationHours * 60 * 60 * 1000;
	const blocks: SessionBlock[] = [];
	const sortedEntries = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

	let currentBlockStart: Date | null = null;
	let currentBlockEntries: LoadedUsageEntry[] = [];
	const now = new Date();

	for (const entry of sortedEntries) {
		const entryTime = entry.timestamp;

		if (currentBlockStart == null) {
			// First entry - start a new block (floored to the hour)
			currentBlockStart = floorToHour(entryTime);
			currentBlockEntries = [entry];
		}
		else {
			const timeSinceBlockStart = entryTime.getTime() - currentBlockStart.getTime();
			const lastEntry = currentBlockEntries.at(-1);
			if (lastEntry == null) {
				continue;
			}
			const lastEntryTime = lastEntry.timestamp;
			const timeSinceLastEntry = entryTime.getTime() - lastEntryTime.getTime();

			if (timeSinceBlockStart > sessionDurationMs || timeSinceLastEntry > sessionDurationMs) {
				// Close current block
				const block = createBlock(currentBlockStart, currentBlockEntries, now, sessionDurationMs);
				blocks.push(block);

				// Add gap block if there's a significant gap
				if (timeSinceLastEntry > sessionDurationMs) {
					const gapBlock = createGapBlock(lastEntryTime, entryTime, sessionDurationMs);
					if (gapBlock != null) {
						blocks.push(gapBlock);
					}
				}

				// Start new block (floored to the hour)
				currentBlockStart = floorToHour(entryTime);
				currentBlockEntries = [entry];
			}
			else {
				// Add to current block
				currentBlockEntries.push(entry);
			}
		}
	}

	// Close the last block
	if (currentBlockStart != null && currentBlockEntries.length > 0) {
		const block = createBlock(currentBlockStart, currentBlockEntries, now, sessionDurationMs);
		blocks.push(block);
	}

	return blocks;
}

/**
 * Creates a session block from a start time and usage entries
 * @param startTime - When the block started
 * @param entries - Usage entries in this block
 * @param now - Current time for active block detection
 * @param sessionDurationMs - Session duration in milliseconds
 * @returns Session block with aggregated data
 */
function createBlock(startTime: Date, entries: LoadedUsageEntry[], now: Date, sessionDurationMs: number): SessionBlock {
	const endTime = new Date(startTime.getTime() + sessionDurationMs);
	const lastEntry = entries[entries.length - 1];
	const actualEndTime = lastEntry != null ? lastEntry.timestamp : startTime;
	const isActive = now.getTime() - actualEndTime.getTime() < sessionDurationMs && now < endTime;

	// Aggregate token counts
	const tokenCounts: TokenCounts = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
	};

	let costUSD = 0;
	const models: string[] = [];

	for (const entry of entries) {
		tokenCounts.inputTokens += entry.usage.inputTokens;
		tokenCounts.outputTokens += entry.usage.outputTokens;
		tokenCounts.cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
		tokenCounts.cacheReadInputTokens += entry.usage.cacheReadInputTokens;
		costUSD += entry.costUSD ?? 0;
		models.push(entry.model);
	}

	return {
		id: startTime.toISOString(),
		startTime,
		endTime,
		actualEndTime,
		isActive,
		entries,
		tokenCounts,
		costUSD,
		models: uniq(models),
	};
}

/**
 * Creates a gap block representing periods with no activity
 * @param lastActivityTime - Time of last activity before gap
 * @param nextActivityTime - Time of next activity after gap
 * @param sessionDurationMs - Session duration in milliseconds
 * @returns Gap block or null if gap is too short
 */
function createGapBlock(lastActivityTime: Date, nextActivityTime: Date, sessionDurationMs: number): SessionBlock | null {
	// Only create gap blocks for gaps longer than the session duration
	const gapDuration = nextActivityTime.getTime() - lastActivityTime.getTime();
	if (gapDuration <= sessionDurationMs) {
		return null;
	}

	const gapStart = new Date(lastActivityTime.getTime() + sessionDurationMs);
	const gapEnd = nextActivityTime;

	return {
		id: `gap-${gapStart.toISOString()}`,
		startTime: gapStart,
		endTime: gapEnd,
		isActive: false,
		isGap: true,
		entries: [],
		tokenCounts: {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		},
		costUSD: 0,
		models: [],
	};
}

/**
 * Calculates the burn rate (tokens/minute and cost/hour) for a session block
 * @param block - Session block to analyze
 * @returns Burn rate calculations or null if block has no activity
 */
export function calculateBurnRate(block: SessionBlock): BurnRate | null {
	if (block.entries.length === 0 || (block.isGap ?? false)) {
		return null;
	}

	const firstEntryData = block.entries[0];
	const lastEntryData = block.entries[block.entries.length - 1];
	if (firstEntryData == null || lastEntryData == null) {
		return null;
	}

	const firstEntry = firstEntryData.timestamp;
	const lastEntry = lastEntryData.timestamp;
	const durationMinutes = (lastEntry.getTime() - firstEntry.getTime()) / (1000 * 60);

	if (durationMinutes <= 0) {
		return null;
	}

	const totalTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
	const tokensPerMinute = totalTokens / durationMinutes;
	const costPerHour = (block.costUSD / durationMinutes) * 60;

	// Calculate activity density for sparse usage detection
	let activityDensity: number | undefined;

	// Detect sparse usage by analyzing entry distribution
	// If entries are very sparse compared to session duration, calculate density
	const averageMinutesBetweenEntries = durationMinutes / Math.max(1, block.entries.length - 1);
	const SPARSE_THRESHOLD_MINUTES = 5; // If entries are >5 minutes apart on average, consider sparse

	if (averageMinutesBetweenEntries > SPARSE_THRESHOLD_MINUTES && block.entries.length < 100) {
		// Calculate the actual activity windows
		const entryTimeSlots = block.entries.map(entry => entry.timestamp.getTime());
		entryTimeSlots.sort((a, b) => a - b);

		if (entryTimeSlots.length > 0) {
			// Estimate active time by grouping entries into activity bursts
			let totalActiveMinutes = 0;
			let currentBurstStart = entryTimeSlots[0]!;
			let lastEntryTime = entryTimeSlots[0]!;
			const BURST_GAP_MINUTES = 10; // Entries within 10 minutes are considered part of same burst

			for (let i = 1; i < entryTimeSlots.length; i++) {
				const currentTime = entryTimeSlots[i]!;
				const gapMinutes = (currentTime - lastEntryTime) / (1000 * 60);

				if (gapMinutes > BURST_GAP_MINUTES) {
					// End of current burst
					totalActiveMinutes += (lastEntryTime - currentBurstStart) / (1000 * 60);
					currentBurstStart = currentTime;
				}
				lastEntryTime = currentTime;
			}

			// Add the final burst
			totalActiveMinutes += (lastEntryTime - currentBurstStart) / (1000 * 60);

			// Ensure minimum active time (at least 1 minute per burst)
			const numberOfBursts = Math.max(1, Math.ceil(totalActiveMinutes / BURST_GAP_MINUTES) || 1);
			totalActiveMinutes = Math.max(totalActiveMinutes, numberOfBursts);

			// Calculate density as ratio of active time to total span
			activityDensity = Math.min(1, totalActiveMinutes / durationMinutes);
		}
	}

	return {
		tokensPerMinute,
		costPerHour,
		activityDensity,
	};
}

/**
 * Projects total usage for an active session block based on current burn rate
 * @param block - Active session block to project
 * @returns Projected usage totals or null if block is inactive or has no burn rate
 */
export function projectBlockUsage(block: SessionBlock): ProjectedUsage | null {
	if (!block.isActive || (block.isGap ?? false)) {
		return null;
	}

	const burnRate = calculateBurnRate(block);
	if (burnRate == null) {
		return null;
	}

	const now = new Date();
	const remainingTime = block.endTime.getTime() - now.getTime();
	const remainingMinutes = Math.max(0, remainingTime / (1000 * 60));

	const currentTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;

	// Adjust projection based on activity density for sparse usage
	let effectiveRemainingMinutes = remainingMinutes;
	if (burnRate.activityDensity != null && burnRate.activityDensity < 1) {
		// For sparse usage, assume the model will only be active for a portion of the remaining time
		// This prevents unrealistic projections for sporadically used models
		effectiveRemainingMinutes = remainingMinutes * burnRate.activityDensity;
	}

	const projectedAdditionalTokens = burnRate.tokensPerMinute * effectiveRemainingMinutes;
	const totalTokens = currentTokens + projectedAdditionalTokens;

	const projectedAdditionalCost = (burnRate.costPerHour / 60) * effectiveRemainingMinutes;
	const totalCost = block.costUSD + projectedAdditionalCost;

	return {
		totalTokens: Math.round(totalTokens),
		totalCost: Math.round(totalCost * 100) / 100,
		remainingMinutes: Math.round(remainingMinutes),
	};
}

/**
 * Calculates per-model cost and token breakdown for a session block
 * @param block - Session block to analyze
 * @returns Per-model breakdown with costs, tokens, and entry counts
 */
export function calculatePerModelCosts(block: SessionBlock): PerModelBreakdown {
	const breakdown: PerModelBreakdown = {};

	// Skip gap blocks
	if (block.isGap ?? false) {
		return breakdown;
	}

	for (const entry of block.entries) {
		const modelName = entry.model;

		if (breakdown[modelName] == null) {
			breakdown[modelName] = {
				costUSD: 0,
				totalTokens: 0,
				entries: 0,
			};
		}

		breakdown[modelName].costUSD += entry.costUSD ?? 0;
		breakdown[modelName].totalTokens += entry.usage.inputTokens + entry.usage.outputTokens;
		breakdown[modelName].entries += 1;
	}

	return breakdown;
}

/**
 * Finds the global maximum cost and tokens per model across all session blocks
 * @param blocks - Array of session blocks to analyze
 * @returns Global maximum values per model
 */
export function findGlobalModelMaxes(blocks: SessionBlock[]): PerModelBreakdown {
	const globalMaxes: PerModelBreakdown = {};

	for (const block of blocks) {
		// Skip gap blocks and active blocks for historical max calculation
		if ((block.isGap ?? false) || block.isActive) {
			continue;
		}

		const blockBreakdown = calculatePerModelCosts(block);

		for (const [modelName, modelData] of Object.entries(blockBreakdown)) {
			if (globalMaxes[modelName] == null) {
				globalMaxes[modelName] = {
					costUSD: modelData.costUSD,
					totalTokens: modelData.totalTokens,
					entries: modelData.entries,
				};
			}
			else {
				// Track maximum values for each metric
				globalMaxes[modelName].costUSD = Math.max(globalMaxes[modelName].costUSD, modelData.costUSD);
				globalMaxes[modelName].totalTokens = Math.max(globalMaxes[modelName].totalTokens, modelData.totalTokens);
				globalMaxes[modelName].entries = Math.max(globalMaxes[modelName].entries, modelData.entries);
			}
		}
	}

	return globalMaxes;
}

/**
 * Finds all historical values per model across completed session blocks for ranking
 * Uses block-level costs and tokens for proper ranking, not per-model breakdown within blocks
 * @param blocks - Array of session blocks to analyze
 * @returns All historical values per model, sorted in descending order for ranking
 */
export function findGlobalModelHistoricalValues(blocks: SessionBlock[]): PerModelHistoricalValues {
	const historicalValues: PerModelHistoricalValues = {};

	for (const block of blocks) {
		// Skip gap blocks and active blocks for historical ranking calculation
		if ((block.isGap ?? false) || block.isActive) {
			continue;
		}

		// Only include blocks that have meaningful usage (non-zero cost or tokens)
		const totalTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
		const hasUsage = block.costUSD > 0 || totalTokens > 0;
		if (!hasUsage) {
			continue;
		}

		// Use block-level costs and tokens, but organize by models used in the block
		// This ensures that ranking is based on total block values, not per-model breakdowns
		for (const modelName of block.models) {
			if (historicalValues[modelName] == null) {
				historicalValues[modelName] = {
					costUSD: [],
					totalTokens: [],
					entries: [],
				};
			}

			// Add the full block cost and tokens to each model that was used in the block
			// This preserves block-level ranking while supporting model filtering
			historicalValues[modelName].costUSD.push(block.costUSD);
			historicalValues[modelName].totalTokens.push(totalTokens);
			historicalValues[modelName].entries.push(block.entries.length);
		}
	}

	// Sort all arrays together by cost in descending order to maintain correspondence
	for (const modelData of Object.values(historicalValues)) {
		// Create array of indices and sort by cost (descending)
		const indices = Array.from({ length: modelData.costUSD.length }, (_, i) => i);
		indices.sort((a, b) => modelData.costUSD[b]! - modelData.costUSD[a]!);

		// Reorder all arrays according to the sorted indices
		const sortedCosts = indices.map(i => modelData.costUSD[i]!);
		const sortedTokens = indices.map(i => modelData.totalTokens[i]!);
		const sortedEntries = indices.map(i => modelData.entries[i]!);

		modelData.costUSD = sortedCosts;
		modelData.totalTokens = sortedTokens;
		modelData.entries = sortedEntries;
	}

	return historicalValues;
}

/**
 * Gets the nth highest cost from historical values for the specified models
 * @param historicalValues - Historical values per model
 * @param models - Array of model names to filter by (undefined for no filter)
 * @param rank - Rank to retrieve (1 = highest, 2 = second highest, etc.)
 * @returns Nth highest cost value or undefined if insufficient data
 */
export function getNthHighestCost(historicalValues: PerModelHistoricalValues, models: string[] | undefined, rank: number): number | undefined {
	if (rank < 1) {
		return undefined;
	}

	// Collect all cost values from matching models
	const allCosts: number[] = [];

	for (const [modelName, modelData] of Object.entries(historicalValues)) {
		const modelMatches = models == null || models.length === 0 || models.some((filterModel) => {
			const lowerFilterModel = filterModel.toLowerCase();
			const lowerModelName = modelName.toLowerCase();
			return lowerModelName.includes(lowerFilterModel) || lowerFilterModel.includes(lowerModelName);
		});

		if (modelMatches) {
			allCosts.push(...modelData.costUSD);
		}
	}

	// Sort all costs in descending order
	allCosts.sort((a, b) => b - a);

	// For unfiltered queries, deduplicate costs to get unique block costs
	// For filtered queries, keep duplicates since they represent different occurrences
	if (models == null || models.length === 0) {
		const uniqueCosts = [...new Set(allCosts)];
		return uniqueCosts[rank - 1];
	}

	return allCosts[rank - 1];
}

/**
 * Gets the nth highest token count from historical values for the specified models
 * @param historicalValues - Historical values per model
 * @param models - Array of model names to filter by (undefined for no filter)
 * @param rank - Rank to retrieve (1 = highest, 2 = second highest, etc.)
 * @returns Nth highest token count or undefined if insufficient data
 */
export function getNthHighestTokens(historicalValues: PerModelHistoricalValues, models: string[] | undefined, rank: number): number | undefined {
	if (rank < 1) {
		return undefined;
	}

	// Collect all token counts from matching models
	const allTokens: number[] = [];

	for (const [modelName, modelData] of Object.entries(historicalValues)) {
		const modelMatches = models == null || models.length === 0 || models.some((filterModel) => {
			const lowerFilterModel = filterModel.toLowerCase();
			const lowerModelName = modelName.toLowerCase();
			return lowerModelName.includes(lowerFilterModel) || lowerFilterModel.includes(lowerModelName);
		});

		if (modelMatches) {
			allTokens.push(...modelData.totalTokens);
		}
	}

	// Sort all token counts in descending order
	allTokens.sort((a, b) => b - a);

	// For unfiltered queries, deduplicate tokens to get unique block values
	// For filtered queries, keep duplicates since they represent different occurrences
	if (models == null || models.length === 0) {
		const uniqueTokens = [...new Set(allTokens)];
		return uniqueTokens[rank - 1];
	}

	return allTokens[rank - 1];
}

/**
 * Gets the appropriate cost limit for the specified models
 * @param globalMaxes - Global per-model maximum values
 * @param models - Array of model names to filter by (undefined for no filter)
 * @returns Maximum cost limit for the specified models
 */
export function getModelCostLimit(globalMaxes: PerModelBreakdown, models?: string[]): number {
	if (models == null || models.length === 0) {
		// No model filter - return the highest cost across all models
		return Math.max(...Object.values(globalMaxes).map(data => data.costUSD), 0);
	}

	// Model filter applied - find the highest cost among matching models
	let maxCost = 0;
	for (const [modelName, modelData] of Object.entries(globalMaxes)) {
		const modelMatches = models.some((filterModel) => {
			const lowerFilterModel = filterModel.toLowerCase();
			const lowerModelName = modelName.toLowerCase();
			return lowerModelName.includes(lowerFilterModel) || lowerFilterModel.includes(lowerModelName);
		});

		if (modelMatches) {
			maxCost = Math.max(maxCost, modelData.costUSD);
		}
	}

	return maxCost;
}

/**
 * Gets the appropriate token limit for the specified models
 * @param globalMaxes - Global per-model maximum values
 * @param models - Array of model names to filter by (undefined for no filter)
 * @returns Maximum token limit for the specified models
 */
export function getModelTokenLimit(globalMaxes: PerModelBreakdown, models?: string[]): number {
	if (models == null || models.length === 0) {
		// No model filter - return the highest token count across all models
		return Math.max(...Object.values(globalMaxes).map(data => data.totalTokens), 0);
	}

	// Model filter applied - find the highest token count among matching models
	let maxTokens = 0;
	for (const [modelName, modelData] of Object.entries(globalMaxes)) {
		const modelMatches = models.some((filterModel) => {
			const lowerFilterModel = filterModel.toLowerCase();
			const lowerModelName = modelName.toLowerCase();
			return lowerModelName.includes(lowerFilterModel) || lowerFilterModel.includes(lowerModelName);
		});

		if (modelMatches) {
			maxTokens = Math.max(maxTokens, modelData.totalTokens);
		}
	}

	return maxTokens;
}

/**
 * Filters session blocks to include only recent ones and active blocks
 * @param blocks - Array of session blocks to filter
 * @param days - Number of recent days to include (default: 3)
 * @returns Filtered array of recent or active blocks
 */
export function filterRecentBlocks(blocks: SessionBlock[], days: number = DEFAULT_RECENT_DAYS): SessionBlock[] {
	const now = new Date();
	const cutoffTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

	return blocks.filter((block) => {
		// Include block if it started after cutoff or if it's still active
		return block.startTime >= cutoffTime || block.isActive;
	});
}

if (import.meta.vitest != null) {
	const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;

	function createMockEntry(
		timestamp: Date,
		inputTokens = 1000,
		outputTokens = 500,
		model = 'claude-sonnet-4-20250514',
		costUSD = 0.01,
	): LoadedUsageEntry {
		return {
			timestamp,
			usage: {
				inputTokens,
				outputTokens,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			},
			costUSD,
			model,
		};
	}

	describe('identifySessionBlocks', () => {
		it('returns empty array for empty entries', () => {
			const result = identifySessionBlocks([]);
			expect(result).toEqual([]);
		});

		it('creates single block for entries within 5 hours', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000)), // 1 hour later
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
			];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.startTime).toEqual(baseTime);
			expect(blocks[0]?.entries).toHaveLength(3);
			expect(blocks[0]?.tokenCounts.inputTokens).toBe(3000);
			expect(blocks[0]?.tokenCounts.outputTokens).toBe(1500);
			expect(blocks[0]?.costUSD).toBe(0.03);
		});

		it('creates multiple blocks when entries span more than 5 hours', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 6 * 60 * 60 * 1000)), // 6 hours later
			];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(3); // first block, gap block, second block
			expect(blocks[0]?.entries).toHaveLength(1);
			expect(blocks[1]?.isGap).toBe(true); // gap block
			expect(blocks[2]?.entries).toHaveLength(1);
		});

		it('creates gap block when there is a gap longer than 5 hours', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
				createMockEntry(new Date(baseTime.getTime() + 8 * 60 * 60 * 1000)), // 8 hours later
			];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(3); // first block, gap block, second block
			expect(blocks[0]?.entries).toHaveLength(2);
			expect(blocks[1]?.isGap).toBe(true);
			expect(blocks[1]?.entries).toHaveLength(0);
			expect(blocks[2]?.entries).toHaveLength(1);
		});

		it('sorts entries by timestamp before processing', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
				createMockEntry(baseTime), // earlier
				createMockEntry(new Date(baseTime.getTime() + 1 * 60 * 60 * 1000)), // 1 hour later
			];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.entries[0]?.timestamp).toEqual(baseTime);
			expect(blocks[0]?.entries[1]?.timestamp).toEqual(new Date(baseTime.getTime() + 1 * 60 * 60 * 1000));
			expect(blocks[0]?.entries[2]?.timestamp).toEqual(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000));
		});

		it('aggregates different models correctly', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514'),
				createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000), 2000, 1000, 'claude-opus-4-20250514'),
			];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.models).toEqual(['claude-sonnet-4-20250514', 'claude-opus-4-20250514']);
		});

		it('handles null costUSD correctly', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514', 0.01),
				{ ...createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000)), costUSD: null },
			];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.costUSD).toBe(0.01); // Only the first entry's cost
		});

		it('sets correct block ID as ISO string', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [createMockEntry(baseTime)];

			const blocks = identifySessionBlocks(entries);
			expect(blocks[0]?.id).toBe(baseTime.toISOString());
		});

		it('sets correct endTime as startTime + 5 hours', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [createMockEntry(baseTime)];

			const blocks = identifySessionBlocks(entries);
			expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + SESSION_DURATION_MS));
		});

		it('handles cache tokens correctly', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entry: LoadedUsageEntry = {
				timestamp: baseTime,
				usage: {
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationInputTokens: 100,
					cacheReadInputTokens: 200,
				},
				costUSD: 0.01,
				model: 'claude-sonnet-4-20250514',
			};

			const blocks = identifySessionBlocks([entry]);
			expect(blocks[0]?.tokenCounts.cacheCreationInputTokens).toBe(100);
			expect(blocks[0]?.tokenCounts.cacheReadInputTokens).toBe(200);
		});

		it('floors block start time to nearest hour', () => {
			const entryTime = new Date('2024-01-01T10:55:30Z'); // 10:55:30 AM
			const expectedStartTime = new Date('2024-01-01T10:00:00Z'); // Should floor to 10:00:00 AM
			const entries: LoadedUsageEntry[] = [createMockEntry(entryTime)];

			const blocks = identifySessionBlocks(entries);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.startTime).toEqual(expectedStartTime);
			expect(blocks[0]?.id).toBe(expectedStartTime.toISOString());
		});
	});

	describe('calculateBurnRate', () => {
		it('returns null for empty entries', () => {
			const block: SessionBlock = {
				id: '2024-01-01T10:00:00.000Z',
				startTime: new Date('2024-01-01T10:00:00Z'),
				endTime: new Date('2024-01-01T15:00:00Z'),
				isActive: true,
				entries: [],
				tokenCounts: {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0,
				models: [],
			};

			const result = calculateBurnRate(block);
			expect(result).toBeNull();
		});

		it('returns null for gap blocks', () => {
			const block: SessionBlock = {
				id: 'gap-2024-01-01T10:00:00.000Z',
				startTime: new Date('2024-01-01T10:00:00Z'),
				endTime: new Date('2024-01-01T15:00:00Z'),
				isActive: false,
				isGap: true,
				entries: [],
				tokenCounts: {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0,
				models: [],
			};

			const result = calculateBurnRate(block);
			expect(result).toBeNull();
		});

		it('returns null when duration is zero or negative', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const block: SessionBlock = {
				id: baseTime.toISOString(),
				startTime: baseTime,
				endTime: new Date(baseTime.getTime() + SESSION_DURATION_MS),
				isActive: true,
				entries: [
					createMockEntry(baseTime),
					createMockEntry(baseTime), // Same timestamp
				],
				tokenCounts: {
					inputTokens: 2000,
					outputTokens: 1000,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0.02,
				models: ['claude-sonnet-4-20250514'],
			};

			const result = calculateBurnRate(block);
			expect(result).toBeNull();
		});

		it('calculates burn rate correctly', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const laterTime = new Date(baseTime.getTime() + 60 * 1000); // 1 minute later
			const block: SessionBlock = {
				id: baseTime.toISOString(),
				startTime: baseTime,
				endTime: new Date(baseTime.getTime() + SESSION_DURATION_MS),
				isActive: true,
				entries: [
					createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514', 0.01),
					createMockEntry(laterTime, 2000, 1000, 'claude-sonnet-4-20250514', 0.02),
				],
				tokenCounts: {
					inputTokens: 3000,
					outputTokens: 1500,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0.03,
				models: ['claude-sonnet-4-20250514'],
			};

			const result = calculateBurnRate(block);
			expect(result).not.toBeNull();
			expect(result?.tokensPerMinute).toBe(4500); // 4500 tokens / 1 minute
			expect(result?.costPerHour).toBeCloseTo(1.8, 2); // 0.03 / 1 minute * 60 minutes
		});
	});

	describe('projectBlockUsage', () => {
		it('returns null for inactive blocks', () => {
			const block: SessionBlock = {
				id: '2024-01-01T10:00:00.000Z',
				startTime: new Date('2024-01-01T10:00:00Z'),
				endTime: new Date('2024-01-01T15:00:00Z'),
				isActive: false,
				entries: [],
				tokenCounts: {
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0.01,
				models: [],
			};

			const result = projectBlockUsage(block);
			expect(result).toBeNull();
		});

		it('returns null for gap blocks', () => {
			const block: SessionBlock = {
				id: 'gap-2024-01-01T10:00:00.000Z',
				startTime: new Date('2024-01-01T10:00:00Z'),
				endTime: new Date('2024-01-01T15:00:00Z'),
				isActive: true,
				isGap: true,
				entries: [],
				tokenCounts: {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0,
				models: [],
			};

			const result = projectBlockUsage(block);
			expect(result).toBeNull();
		});

		it('returns null when burn rate cannot be calculated', () => {
			const block: SessionBlock = {
				id: '2024-01-01T10:00:00.000Z',
				startTime: new Date('2024-01-01T10:00:00Z'),
				endTime: new Date('2024-01-01T15:00:00Z'),
				isActive: true,
				entries: [], // Empty entries
				tokenCounts: {
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0.01,
				models: [],
			};

			const result = projectBlockUsage(block);
			expect(result).toBeNull();
		});

		it('projects usage correctly for active block', () => {
			const now = new Date();
			const startTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
			const endTime = new Date(startTime.getTime() + SESSION_DURATION_MS);
			const pastTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 minutes after start

			const block: SessionBlock = {
				id: startTime.toISOString(),
				startTime,
				endTime,
				isActive: true,
				entries: [
					createMockEntry(startTime, 1000, 500, 'claude-sonnet-4-20250514', 0.01),
					createMockEntry(pastTime, 2000, 1000, 'claude-sonnet-4-20250514', 0.02),
				],
				tokenCounts: {
					inputTokens: 3000,
					outputTokens: 1500,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
				costUSD: 0.03,
				models: ['claude-sonnet-4-20250514'],
			};

			const result = projectBlockUsage(block);
			expect(result).not.toBeNull();
			expect(result?.totalTokens).toBeGreaterThan(4500); // Current tokens + projected
			expect(result?.totalCost).toBeGreaterThan(0.03); // Current cost + projected
			expect(result?.remainingMinutes).toBeGreaterThan(0);
		});
	});

	describe('filterRecentBlocks', () => {
		it('filters blocks correctly with default 3 days', () => {
			const now = new Date();
			const recentTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
			const oldTime = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

			const blocks: SessionBlock[] = [
				{
					id: recentTime.toISOString(),
					startTime: recentTime,
					endTime: new Date(recentTime.getTime() + SESSION_DURATION_MS),
					isActive: false,
					entries: [],
					tokenCounts: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					costUSD: 0.01,
					models: [],
				},
				{
					id: oldTime.toISOString(),
					startTime: oldTime,
					endTime: new Date(oldTime.getTime() + SESSION_DURATION_MS),
					isActive: false,
					entries: [],
					tokenCounts: {
						inputTokens: 2000,
						outputTokens: 1000,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					costUSD: 0.02,
					models: [],
				},
			];

			const result = filterRecentBlocks(blocks);
			expect(result).toHaveLength(1);
			expect(result[0]?.startTime).toEqual(recentTime);
		});

		it('includes active blocks regardless of age', () => {
			const now = new Date();
			const oldTime = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

			const blocks: SessionBlock[] = [
				{
					id: oldTime.toISOString(),
					startTime: oldTime,
					endTime: new Date(oldTime.getTime() + SESSION_DURATION_MS),
					isActive: true, // Active block
					entries: [],
					tokenCounts: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					costUSD: 0.01,
					models: [],
				},
			];

			const result = filterRecentBlocks(blocks);
			expect(result).toHaveLength(1);
			expect(result[0]?.isActive).toBe(true);
		});

		it('supports custom days parameter', () => {
			const now = new Date();
			const withinCustomRange = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
			const outsideCustomRange = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

			const blocks: SessionBlock[] = [
				{
					id: withinCustomRange.toISOString(),
					startTime: withinCustomRange,
					endTime: new Date(withinCustomRange.getTime() + SESSION_DURATION_MS),
					isActive: false,
					entries: [],
					tokenCounts: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					costUSD: 0.01,
					models: [],
				},
				{
					id: outsideCustomRange.toISOString(),
					startTime: outsideCustomRange,
					endTime: new Date(outsideCustomRange.getTime() + SESSION_DURATION_MS),
					isActive: false,
					entries: [],
					tokenCounts: {
						inputTokens: 2000,
						outputTokens: 1000,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					costUSD: 0.02,
					models: [],
				},
			];

			const result = filterRecentBlocks(blocks, 7); // 7 days
			expect(result).toHaveLength(1);
			expect(result[0]?.startTime).toEqual(withinCustomRange);
		});

		it('returns empty array when no blocks match criteria', () => {
			const now = new Date();
			const oldTime = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

			const blocks: SessionBlock[] = [
				{
					id: oldTime.toISOString(),
					startTime: oldTime,
					endTime: new Date(oldTime.getTime() + SESSION_DURATION_MS),
					isActive: false,
					entries: [],
					tokenCounts: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					costUSD: 0.01,
					models: [],
				},
			];

			const result = filterRecentBlocks(blocks, 3);
			expect(result).toHaveLength(0);
		});
	});

	describe('identifySessionBlocks with configurable duration', () => {
		it('creates single block for entries within custom 3-hour duration', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000)), // 1 hour later
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
			];

			const blocks = identifySessionBlocks(entries, 3);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.startTime).toEqual(baseTime);
			expect(blocks[0]?.entries).toHaveLength(3);
			expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + 3 * 60 * 60 * 1000));
		});

		it('creates multiple blocks with custom 2-hour duration', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 3 * 60 * 60 * 1000)), // 3 hours later (beyond 2h limit)
			];

			const blocks = identifySessionBlocks(entries, 2);
			expect(blocks).toHaveLength(3); // first block, gap block, second block
			expect(blocks[0]?.entries).toHaveLength(1);
			expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000));
			expect(blocks[1]?.isGap).toBe(true); // gap block
			expect(blocks[2]?.entries).toHaveLength(1);
		});

		it('creates gap block with custom 1-hour duration', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 30 * 60 * 1000)), // 30 minutes later (within 1h)
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later (beyond 1h)
			];

			const blocks = identifySessionBlocks(entries, 1);
			expect(blocks).toHaveLength(3); // first block, gap block, second block
			expect(blocks[0]?.entries).toHaveLength(2);
			expect(blocks[1]?.isGap).toBe(true);
			expect(blocks[2]?.entries).toHaveLength(1);
		});

		it('works with fractional hours (2.5 hours)', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later (within 2.5h)
				createMockEntry(new Date(baseTime.getTime() + 6 * 60 * 60 * 1000)), // 6 hours later (4 hours from last entry, beyond 2.5h)
			];

			const blocks = identifySessionBlocks(entries, 2.5);
			expect(blocks).toHaveLength(3); // first block, gap block, second block
			expect(blocks[0]?.entries).toHaveLength(2);
			expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + 2.5 * 60 * 60 * 1000));
			expect(blocks[1]?.isGap).toBe(true);
			expect(blocks[2]?.entries).toHaveLength(1);
		});

		it('works with very short duration (0.5 hours)', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 20 * 60 * 1000)), // 20 minutes later (within 0.5h)
				createMockEntry(new Date(baseTime.getTime() + 80 * 60 * 1000)), // 80 minutes later (60 minutes from last entry, beyond 0.5h)
			];

			const blocks = identifySessionBlocks(entries, 0.5);
			expect(blocks).toHaveLength(3); // first block, gap block, second block
			expect(blocks[0]?.entries).toHaveLength(2);
			expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + 0.5 * 60 * 60 * 1000));
			expect(blocks[1]?.isGap).toBe(true);
			expect(blocks[2]?.entries).toHaveLength(1);
		});

		it('works with very long duration (24 hours)', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 12 * 60 * 60 * 1000)), // 12 hours later (within 24h)
				createMockEntry(new Date(baseTime.getTime() + 20 * 60 * 60 * 1000)), // 20 hours later (within 24h)
			];

			const blocks = identifySessionBlocks(entries, 24);
			expect(blocks).toHaveLength(1); // single block
			expect(blocks[0]?.entries).toHaveLength(3);
			expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + 24 * 60 * 60 * 1000));
		});

		it('gap detection respects custom duration', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 1 * 60 * 60 * 1000)), // 1 hour later
				createMockEntry(new Date(baseTime.getTime() + 5 * 60 * 60 * 1000)), // 5 hours later (4h from last entry, beyond 3h)
			];

			const blocks = identifySessionBlocks(entries, 3);
			expect(blocks).toHaveLength(3); // first block, gap block, second block

			// Gap block should start 3 hours after last activity in first block
			const gapBlock = blocks[1];
			expect(gapBlock?.isGap).toBe(true);
			expect(gapBlock?.startTime).toEqual(new Date(baseTime.getTime() + 1 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)); // 1h + 3h
			expect(gapBlock?.endTime).toEqual(new Date(baseTime.getTime() + 5 * 60 * 60 * 1000)); // 5h
		});

		it('no gap created when gap is exactly equal to session duration', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
				createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // exactly 2 hours later (equal to session duration)
			];

			const blocks = identifySessionBlocks(entries, 2);
			expect(blocks).toHaveLength(1); // single block (entries are exactly at session boundary)
			expect(blocks[0]?.entries).toHaveLength(2);
		});

		it('defaults to 5 hours when no duration specified', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime),
			];

			const blocksDefault = identifySessionBlocks(entries);
			const blocksExplicit = identifySessionBlocks(entries, 5);

			expect(blocksDefault).toHaveLength(1);
			expect(blocksExplicit).toHaveLength(1);
			expect(blocksDefault[0]!.endTime).toEqual(blocksExplicit[0]!.endTime);
			expect(blocksDefault[0]!.endTime).toEqual(new Date(baseTime.getTime() + 5 * 60 * 60 * 1000));
		});
	});

	describe('findGlobalModelHistoricalValues', () => {
		it('returns empty object for empty blocks', () => {
			const result = findGlobalModelHistoricalValues([]);
			expect(result).toEqual({});
		});

		it('collects block-level historical values from completed blocks', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const blocks: SessionBlock[] = [
				{
					id: baseTime.toISOString(),
					startTime: baseTime,
					endTime: new Date(baseTime.getTime() + 5 * 60 * 60 * 1000),
					entries: [
						createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514', 10.50),
						createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000), 2000, 1000, 'claude-opus-4-20250514', 25.00),
					],
					tokenCounts: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 35.50, // Block-level cost (total for this 5-hour block)
					isActive: false,
					models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
				},
				{
					id: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000).toISOString(),
					startTime: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000),
					endTime: new Date(baseTime.getTime() + 15 * 60 * 60 * 1000),
					entries: [
						createMockEntry(new Date(baseTime.getTime() + 10 * 60 * 60 * 1000), 1500, 750, 'claude-sonnet-4-20250514', 8.00),
					],
					tokenCounts: { inputTokens: 1500, outputTokens: 750, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 8.00, // Block-level cost
					isActive: false,
					models: ['claude-sonnet-4-20250514'],
				},
			];

			const result = findGlobalModelHistoricalValues(blocks);

			// Both models in first block get the full block cost and tokens
			expect(result).toEqual({
				'claude-sonnet-4-20250514': {
					costUSD: [35.50, 8.00], // Full block costs, sorted descending
					totalTokens: [4500, 2250], // Full block tokens, sorted descending (4500 > 2250)
					entries: [2, 1], // Number of entries in each block
				},
				'claude-opus-4-20250514': {
					costUSD: [35.50], // Full block cost (shared with sonnet)
					totalTokens: [4500], // Full block tokens (shared with sonnet)
					entries: [2], // Total entries in the block
				},
			});
		});

		it('skips gap blocks and active blocks', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const blocks: SessionBlock[] = [
				{
					id: baseTime.toISOString(),
					startTime: baseTime,
					endTime: new Date(baseTime.getTime() + 5 * 60 * 60 * 1000),
					entries: [createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514', 10.50)],
					tokenCounts: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 10.50,
					isActive: false,
					models: ['claude-sonnet-4-20250514'],
				},
				{
					id: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000).toISOString(),
					startTime: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000),
					endTime: new Date(baseTime.getTime() + 15 * 60 * 60 * 1000),
					entries: [],
					tokenCounts: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 0,
					isActive: false,
					isGap: true,
					models: [],
				},
				{
					id: new Date(baseTime.getTime() + 20 * 60 * 60 * 1000).toISOString(),
					startTime: new Date(baseTime.getTime() + 20 * 60 * 60 * 1000),
					endTime: new Date(baseTime.getTime() + 25 * 60 * 60 * 1000),
					entries: [createMockEntry(new Date(baseTime.getTime() + 20 * 60 * 60 * 1000), 2000, 1000, 'claude-sonnet-4-20250514', 15.00)],
					tokenCounts: { inputTokens: 2000, outputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 15.00,
					isActive: true,
					models: ['claude-sonnet-4-20250514'],
				},
			];

			const result = findGlobalModelHistoricalValues(blocks);

			expect(result).toEqual({
				'claude-sonnet-4-20250514': {
					costUSD: [10.50], // only the completed block
					totalTokens: [1500], // only the completed block (1000 + 500)
					entries: [1],
				},
			});
		});

		it('filters out zero values', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const blocks: SessionBlock[] = [
				{
					id: baseTime.toISOString(),
					startTime: baseTime,
					endTime: new Date(baseTime.getTime() + 5 * 60 * 60 * 1000),
					entries: [createMockEntry(baseTime, 0, 0, 'claude-sonnet-4-20250514', 0)],
					tokenCounts: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 0,
					isActive: false,
					models: ['claude-sonnet-4-20250514'],
				},
				{
					id: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000).toISOString(),
					startTime: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000),
					endTime: new Date(baseTime.getTime() + 15 * 60 * 60 * 1000),
					entries: [createMockEntry(new Date(baseTime.getTime() + 10 * 60 * 60 * 1000), 1000, 500, 'claude-sonnet-4-20250514', 10.50)],
					tokenCounts: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 10.50,
					isActive: false,
					models: ['claude-sonnet-4-20250514'],
				},
			];

			const result = findGlobalModelHistoricalValues(blocks);

			expect(result).toEqual({
				'claude-sonnet-4-20250514': {
					costUSD: [10.50], // zero cost/token blocks filtered out
					totalTokens: [1500], // zero cost/token blocks filtered out (1000 + 500)
					entries: [1], // zero cost/token blocks filtered out
				},
			});
		});

		it('uses block-level costs for ranking, not per-model breakdown', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const blocks: SessionBlock[] = [
				{
					id: baseTime.toISOString(),
					startTime: baseTime,
					endTime: new Date(baseTime.getTime() + 5 * 60 * 60 * 1000),
					entries: [
						createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514', 50.00),
						createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000), 2000, 1000, 'claude-opus-4-20250514', 86.34),
					],
					tokenCounts: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 136.34, // Total block cost - this should be used for ranking, not individual per-model costs
					isActive: false,
					models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
				},
				{
					id: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000).toISOString(),
					startTime: new Date(baseTime.getTime() + 10 * 60 * 60 * 1000),
					endTime: new Date(baseTime.getTime() + 15 * 60 * 60 * 1000),
					entries: [
						createMockEntry(new Date(baseTime.getTime() + 10 * 60 * 60 * 1000), 5000, 2500, 'claude-sonnet-4-20250514', 196.97),
					],
					tokenCounts: { inputTokens: 5000, outputTokens: 2500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 196.97, // Highest block cost
					isActive: false,
					models: ['claude-sonnet-4-20250514'],
				},
				{
					id: new Date(baseTime.getTime() + 20 * 60 * 60 * 1000).toISOString(),
					startTime: new Date(baseTime.getTime() + 20 * 60 * 60 * 1000),
					endTime: new Date(baseTime.getTime() + 25 * 60 * 60 * 1000),
					entries: [
						createMockEntry(new Date(baseTime.getTime() + 20 * 60 * 60 * 1000), 3000, 1500, 'claude-opus-4-20250514', 122.14),
					],
					tokenCounts: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
					costUSD: 122.14, // Third highest block cost
					isActive: false,
					models: ['claude-opus-4-20250514'],
				},
			];

			const result = findGlobalModelHistoricalValues(blocks);

			// Each model should have the full block costs where it was used, sorted descending
			expect(result).toEqual({
				'claude-sonnet-4-20250514': {
					costUSD: [196.97, 136.34], // Full block costs (highest first)
					totalTokens: [7500, 4500], // Full block tokens (7500 > 4500)
					entries: [1, 2], // Number of entries in each block (1 entry in 196.97 block, 2 entries in 136.34 block)
				},
				'claude-opus-4-20250514': {
					costUSD: [136.34, 122.14], // Full block costs (higher first)
					totalTokens: [4500, 4500], // Full block tokens (same tokens, so same order as costs)
					entries: [2, 1], // Number of entries in each block (2 entries in 136.34 block, 1 entry in 122.14 block)
				},
			});

			// Verify ranking behavior with deduplication for unfiltered queries
			const firstMax = getNthHighestCost(result, undefined, 1);
			const secondMax = getNthHighestCost(result, undefined, 2);
			const thirdMax = getNthHighestCost(result, undefined, 3);

			expect(firstMax).toBe(196.97);
			expect(secondMax).toBe(136.34); // This was the bug - it was returning per-model cost instead
			expect(thirdMax).toBe(122.14); // Unique costs: [196.97, 136.34, 122.14]

			// Verify that model filtering preserves duplicates (different behavior)
			const secondMaxSonnet = getNthHighestCost(result, ['sonnet'], 2);
			const thirdMaxSonnet = getNthHighestCost(result, ['sonnet'], 3);
			expect(secondMaxSonnet).toBe(136.34); // With filtering, sonnet appears in 196.97 and 136.34 blocks
			expect(thirdMaxSonnet).toBeUndefined(); // Only 2 blocks contain sonnet
		});
	});

	describe('getNthHighestCost', () => {
		const historicalValues: PerModelHistoricalValues = {
			'claude-sonnet-4-20250514': {
				costUSD: [10.50, 8.00, 6.50], // sorted descending
				totalTokens: [1500, 1200, 1000],
				entries: [1, 1, 1],
			},
			'claude-opus-4-20250514': {
				costUSD: [25.00, 20.00],
				totalTokens: [3000, 2500],
				entries: [1, 1],
			},
		};

		it('returns 1st highest (max) across all models', () => {
			const result = getNthHighestCost(historicalValues, undefined, 1);
			expect(result).toBe(25.00); // highest across all models
		});

		it('returns 2nd highest across all models', () => {
			const result = getNthHighestCost(historicalValues, undefined, 2);
			expect(result).toBe(20.00); // 2nd highest across all models
		});

		it('returns 3rd highest across all models', () => {
			const result = getNthHighestCost(historicalValues, undefined, 3);
			expect(result).toBe(10.50); // 3rd highest across all models
		});

		it('returns undefined for insufficient data', () => {
			const result = getNthHighestCost(historicalValues, undefined, 10);
			expect(result).toBeUndefined();
		});

		it('filters by model correctly', () => {
			const result = getNthHighestCost(historicalValues, ['sonnet'], 1);
			expect(result).toBe(10.50); // highest for sonnet model
		});

		it('returns 2nd highest for filtered model', () => {
			const result = getNthHighestCost(historicalValues, ['sonnet'], 2);
			expect(result).toBe(8.00); // 2nd highest for sonnet model
		});

		it('returns undefined for invalid rank', () => {
			const result = getNthHighestCost(historicalValues, undefined, 0);
			expect(result).toBeUndefined();
		});

		it('handles empty historical values', () => {
			const result = getNthHighestCost({}, undefined, 1);
			expect(result).toBeUndefined();
		});
	});

	describe('getNthHighestTokens', () => {
		const historicalValues: PerModelHistoricalValues = {
			'claude-sonnet-4-20250514': {
				costUSD: [10.50, 8.00, 6.50],
				totalTokens: [1500, 1200, 1000], // sorted descending
				entries: [1, 1, 1],
			},
			'claude-opus-4-20250514': {
				costUSD: [25.00, 20.00],
				totalTokens: [3000, 2500], // sorted descending
				entries: [1, 1],
			},
		};

		it('returns 1st highest (max) tokens across all models', () => {
			const result = getNthHighestTokens(historicalValues, undefined, 1);
			expect(result).toBe(3000); // highest across all models
		});

		it('returns 2nd highest tokens across all models', () => {
			const result = getNthHighestTokens(historicalValues, undefined, 2);
			expect(result).toBe(2500); // 2nd highest across all models
		});

		it('returns 3rd highest tokens across all models', () => {
			const result = getNthHighestTokens(historicalValues, undefined, 3);
			expect(result).toBe(1500); // 3rd highest across all models
		});

		it('returns undefined for insufficient data', () => {
			const result = getNthHighestTokens(historicalValues, undefined, 10);
			expect(result).toBeUndefined();
		});

		it('filters by model correctly', () => {
			const result = getNthHighestTokens(historicalValues, ['opus'], 1);
			expect(result).toBe(3000); // highest for opus model
		});

		it('returns 2nd highest for filtered model', () => {
			const result = getNthHighestTokens(historicalValues, ['opus'], 2);
			expect(result).toBe(2500); // 2nd highest for opus model
		});

		it('returns undefined for invalid rank', () => {
			const result = getNthHighestTokens(historicalValues, undefined, 0);
			expect(result).toBeUndefined();
		});

		it('handles empty historical values', () => {
			const result = getNthHighestTokens({}, undefined, 1);
			expect(result).toBeUndefined();
		});
	});
}
