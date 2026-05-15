import { DEFAULT_RECENT_DAYS } from './_consts.ts';
import { getTotalTokens } from './_token-utils.ts';

/**
 * Default session duration in hours (Claude's billing block duration)
 */
export const DEFAULT_SESSION_DURATION_HOURS = 5;

/**
 * Represents a single usage data entry loaded from JSONL files
 */
export type LoadedUsageEntry = {
	timestamp: Date;
	timestampMs?: number;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	costUSD: number | null;
	model: string;
	version?: string;
	usageLimitResetTime?: Date; // Claude API usage limit reset time
};

/**
 * Returns the millisecond timestamp carried by loaded usage entries.
 *
 * JSONL loading precomputes this value while parsing each row, and session-block
 * grouping reads it many times for ordering, gap detection, and burn-rate math.
 * Falling back to `Date#getTime()` keeps hand-built entries in tests and callers
 * outside the hot parser path working without duplicating timestamp fields.
 */
function getEntryTimestampMs(entry: LoadedUsageEntry): number {
	return entry.timestampMs ?? entry.timestamp.getTime();
}

/**
 * Floors a timestamp to the UTC hour boundary used as a billing-block start.
 *
 * Keeping this as integer millisecond arithmetic avoids allocating intermediate
 * `Date` objects while grouping every usage row into five-hour session blocks.
 */
function floorToHourMs(timestampMs: number): number {
	return Math.floor(timestampMs / (60 * 60 * 1000)) * 60 * 60 * 1000;
}

function getChronologicalEntries(entries: LoadedUsageEntry[]): LoadedUsageEntry[] {
	let previousTimestampMs = getEntryTimestampMs(entries[0]!);
	for (let index = 1; index < entries.length; index++) {
		const timestampMs = getEntryTimestampMs(entries[index]!);
		if (previousTimestampMs > timestampMs) {
			return [...entries].sort((a, b) => getEntryTimestampMs(a) - getEntryTimestampMs(b));
		}
		previousTimestampMs = timestampMs;
	}
	return entries;
}

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
	usageLimitResetTime?: Date; // Claude API usage limit reset time
};

/**
 * Represents usage burn rate calculations
 */
type BurnRate = {
	tokensPerMinute: number;
	tokensPerMinuteForIndicator: number;
	costPerHour: number;
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
	const sortedEntries = getChronologicalEntries(entries);

	let currentBlockStartMs: number | null = null;
	let currentBlockEntries: LoadedUsageEntry[] = [];
	const now = new Date();
	const nowMs = now.getTime();

	for (const entry of sortedEntries) {
		const entryTimeMs = getEntryTimestampMs(entry);

		if (currentBlockStartMs == null) {
			// First entry - start a new block (floored to the hour)
			currentBlockStartMs = floorToHourMs(entryTimeMs);
			currentBlockEntries = [entry];
		} else {
			const timeSinceBlockStart = entryTimeMs - currentBlockStartMs;
			const lastEntry = currentBlockEntries.at(-1);
			if (lastEntry == null) {
				continue;
			}
			const lastEntryTimeMs = getEntryTimestampMs(lastEntry);
			const timeSinceLastEntry = entryTimeMs - lastEntryTimeMs;

			if (timeSinceBlockStart > sessionDurationMs || timeSinceLastEntry > sessionDurationMs) {
				// Close current block
				const block = createBlock(
					currentBlockStartMs,
					currentBlockEntries,
					nowMs,
					sessionDurationMs,
				);
				blocks.push(block);

				// Add gap block if there's a significant gap
				if (timeSinceLastEntry > sessionDurationMs) {
					const gapBlock = createGapBlock(lastEntryTimeMs, entryTimeMs, sessionDurationMs);
					if (gapBlock != null) {
						blocks.push(gapBlock);
					}
				}

				// Start new block (floored to the hour)
				currentBlockStartMs = floorToHourMs(entryTimeMs);
				currentBlockEntries = [entry];
			} else {
				// Add to current block
				currentBlockEntries.push(entry);
			}
		}
	}

	// Close the last block
	if (currentBlockStartMs != null && currentBlockEntries.length > 0) {
		const block = createBlock(currentBlockStartMs, currentBlockEntries, nowMs, sessionDurationMs);
		blocks.push(block);
	}

	return blocks;
}

/**
 * Creates a session block from a start time and usage entries
 * @param startTimeMs - When the block started
 * @param entries - Usage entries in this block
 * @param nowMs - Current time for active block detection
 * @param sessionDurationMs - Session duration in milliseconds
 * @returns Session block with aggregated data
 */
function createBlock(
	startTimeMs: number,
	entries: LoadedUsageEntry[],
	nowMs: number,
	sessionDurationMs: number,
): SessionBlock {
	const startTime = new Date(startTimeMs);
	const endTime = new Date(startTimeMs + sessionDurationMs);
	const lastEntry = entries[entries.length - 1];
	const actualEndTime = lastEntry != null ? lastEntry.timestamp : startTime;
	const actualEndTimeMs = lastEntry != null ? getEntryTimestampMs(lastEntry) : startTimeMs;
	const isActive = nowMs - actualEndTimeMs < sessionDurationMs && nowMs < endTime.getTime();

	// Aggregate token counts
	const tokenCounts: TokenCounts = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
	};

	let costUSD = 0;
	const models = new Set<string>();
	let usageLimitResetTime: Date | undefined;

	for (const entry of entries) {
		tokenCounts.inputTokens += entry.usage.inputTokens;
		tokenCounts.outputTokens += entry.usage.outputTokens;
		tokenCounts.cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
		tokenCounts.cacheReadInputTokens += entry.usage.cacheReadInputTokens;
		costUSD += entry.costUSD ?? 0;
		usageLimitResetTime = entry.usageLimitResetTime ?? usageLimitResetTime;
		models.add(entry.model);
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
		models: Array.from(models),
		usageLimitResetTime,
	};
}

/**
 * Creates a gap block representing periods with no activity
 * @param lastActivityTimeMs - Time of last activity before gap
 * @param nextActivityTimeMs - Time of next activity after gap
 * @param sessionDurationMs - Session duration in milliseconds
 * @returns Gap block or null if gap is too short
 */
function createGapBlock(
	lastActivityTimeMs: number,
	nextActivityTimeMs: number,
	sessionDurationMs: number,
): SessionBlock | null {
	// Only create gap blocks for gaps longer than the session duration
	const gapDuration = nextActivityTimeMs - lastActivityTimeMs;
	if (gapDuration <= sessionDurationMs) {
		return null;
	}

	const gapStart = new Date(lastActivityTimeMs + sessionDurationMs);
	const gapEnd = new Date(nextActivityTimeMs);

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

	const durationMinutes =
		(getEntryTimestampMs(lastEntryData) - getEntryTimestampMs(firstEntryData)) / (1000 * 60);

	if (durationMinutes <= 0) {
		return null;
	}

	const totalTokens = getTotalTokens(block.tokenCounts);
	const tokensPerMinute = totalTokens / durationMinutes;

	// For burn rate indicator (HIGH/MODERATE/NORMAL), use only input and output tokens
	// to maintain consistent thresholds with pre-cache behavior
	const nonCacheTokens =
		(block.tokenCounts.inputTokens ?? 0) + (block.tokenCounts.outputTokens ?? 0);
	const tokensPerMinuteForIndicator = nonCacheTokens / durationMinutes;

	const costPerHour = (block.costUSD / durationMinutes) * 60;

	return {
		tokensPerMinute,
		tokensPerMinuteForIndicator,
		costPerHour,
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

	const currentTokens = getTotalTokens(block.tokenCounts);
	const projectedAdditionalTokens = burnRate.tokensPerMinute * remainingMinutes;
	const totalTokens = currentTokens + projectedAdditionalTokens;

	const projectedAdditionalCost = (burnRate.costPerHour / 60) * remainingMinutes;
	const totalCost = block.costUSD + projectedAdditionalCost;

	return {
		totalTokens: Math.round(totalTokens),
		totalCost: Math.round(totalCost * 100) / 100,
		remainingMinutes: Math.round(remainingMinutes),
	};
}

/**
 * Filters session blocks to include only recent ones and active blocks
 * @param blocks - Array of session blocks to filter
 * @param days - Number of recent days to include (default: 3)
 * @returns Filtered array of recent or active blocks
 */
export function filterRecentBlocks(
	blocks: SessionBlock[],
	days: number = DEFAULT_RECENT_DAYS,
): SessionBlock[] {
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

	describe('getEntryTimestampMs', () => {
		it('uses the precomputed timestampMs when it is present', () => {
			const timestamp = new Date('2024-01-01T00:00:00Z');
			timestamp.getTime = () => {
				throw new Error('timestamp.getTime should not be used');
			};

			const entry = {
				...createMockEntry(timestamp),
				timestampMs: Date.parse('2024-01-01T01:23:45Z'),
			};

			expect(getEntryTimestampMs(entry)).toBe(Date.parse('2024-01-01T01:23:45Z'));
		});

		it('falls back to timestamp.getTime for manually created entries', () => {
			const timestamp = new Date('2024-01-01T02:34:56Z');

			expect(getEntryTimestampMs(createMockEntry(timestamp))).toBe(timestamp.getTime());
		});
	});

	describe('floorToHourMs', () => {
		it('floors a timestamp inside an hour to the hour boundary', () => {
			const timestampMs = Date.parse('2024-01-01T10:59:59.999Z');

			expect(new Date(floorToHourMs(timestampMs)).toISOString()).toBe('2024-01-01T10:00:00.000Z');
		});

		it('keeps an exact hour boundary unchanged', () => {
			const timestampMs = Date.parse('2024-01-01T10:00:00.000Z');

			expect(floorToHourMs(timestampMs)).toBe(timestampMs);
		});
	});

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
			expect(blocks[0]?.entries[1]?.timestamp).toEqual(
				new Date(baseTime.getTime() + 1 * 60 * 60 * 1000),
			);
			expect(blocks[0]?.entries[2]?.timestamp).toEqual(
				new Date(baseTime.getTime() + 2 * 60 * 60 * 1000),
			);
		});

		it('uses timestampMs for block ordering when present', () => {
			const firstTimestamp = new Date('2024-01-01T10:00:00Z');
			const secondTimestamp = new Date('2024-01-01T11:00:00Z');
			firstTimestamp.getTime = () => {
				throw new Error('timestamp.getTime should not be used');
			};
			secondTimestamp.getTime = () => {
				throw new Error('timestamp.getTime should not be used');
			};
			const entries: LoadedUsageEntry[] = [
				{
					...createMockEntry(secondTimestamp),
					timestampMs: Date.parse('2024-01-01T11:00:00Z'),
				},
				{
					...createMockEntry(firstTimestamp),
					timestampMs: Date.parse('2024-01-01T10:00:00Z'),
				},
			];

			const blocks = identifySessionBlocks(entries);

			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.startTime.toISOString()).toBe('2024-01-01T10:00:00.000Z');
			expect(blocks[0]?.entries[0]).toBe(entries[1]);
			expect(blocks[0]?.entries[1]).toBe(entries[0]);
		});

		it('aggregates different models correctly', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const entries: LoadedUsageEntry[] = [
				createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514'),
				createMockEntry(
					new Date(baseTime.getTime() + 60 * 60 * 1000),
					2000,
					1000,
					'claude-opus-4-20250514',
				),
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
			expect(result?.tokensPerMinute).toBe(4500); // 4500 tokens / 1 minute (includes all tokens)
			expect(result?.tokensPerMinuteForIndicator).toBe(4500); // 4500 tokens / 1 minute (non-cache only)
			expect(result?.costPerHour).toBeCloseTo(1.8, 2); // 0.03 / 1 minute * 60 minutes
		});

		it('correctly separates cache and non-cache tokens in burn rate calculation', () => {
			const baseTime = new Date('2024-01-01T10:00:00Z');
			const block: SessionBlock = {
				id: baseTime.toISOString(),
				startTime: baseTime,
				endTime: new Date(baseTime.getTime() + SESSION_DURATION_MS),
				isActive: true,
				entries: [
					{
						timestamp: baseTime,
						usage: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheCreationInputTokens: 0,
							cacheReadInputTokens: 0,
						},
						costUSD: 0.01,
						model: 'claude-sonnet-4-20250514',
					},
					{
						timestamp: new Date(baseTime.getTime() + 60 * 1000),
						usage: {
							inputTokens: 500,
							outputTokens: 200,
							cacheCreationInputTokens: 2000,
							cacheReadInputTokens: 8000,
						},
						costUSD: 0.02,
						model: 'claude-sonnet-4-20250514',
					},
				],
				tokenCounts: {
					inputTokens: 1500,
					outputTokens: 700,
					cacheCreationInputTokens: 2000,
					cacheReadInputTokens: 8000,
				},
				costUSD: 0.03,
				models: ['claude-sonnet-4-20250514'],
			};

			const result = calculateBurnRate(block);
			expect(result).not.toBeNull();
			expect(result?.tokensPerMinute).toBe(12200); // 1500 + 700 + 2000 + 8000 = 12200 tokens / 1 minute
			expect(result?.tokensPerMinuteForIndicator).toBe(2200); // 1500 + 700 = 2200 tokens / 1 minute (non-cache only)
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
			expect(gapBlock?.startTime).toEqual(
				new Date(baseTime.getTime() + 1 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000),
			); // 1h + 3h
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
			const entries: LoadedUsageEntry[] = [createMockEntry(baseTime)];

			const blocksDefault = identifySessionBlocks(entries);
			const blocksExplicit = identifySessionBlocks(entries, 5);

			expect(blocksDefault).toHaveLength(1);
			expect(blocksExplicit).toHaveLength(1);
			expect(blocksDefault[0]!.endTime).toEqual(blocksExplicit[0]!.endTime);
			expect(blocksDefault[0]!.endTime).toEqual(new Date(baseTime.getTime() + 5 * 60 * 60 * 1000));
		});
	});
}
