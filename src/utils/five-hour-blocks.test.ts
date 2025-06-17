import { describe, expect, test } from 'bun:test';
import {
	calculateBurnRate,
	filterRecentBlocks,
	type FiveHourBlock,
	identifyFiveHourBlocks,
	type LoadedUsageEntry,
	projectBlockUsage,
} from './five-hour-blocks.ts';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

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

describe('identifyFiveHourBlocks', () => {
	test('returns empty array for empty entries', () => {
		const result = identifyFiveHourBlocks([]);
		expect(result).toEqual([]);
	});

	test('creates single block for entries within 5 hours', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [
			createMockEntry(baseTime),
			createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000)), // 1 hour later
			createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
		];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.startTime).toEqual(baseTime);
		expect(blocks[0]?.entries).toHaveLength(3);
		expect(blocks[0]?.tokenCounts.inputTokens).toBe(3000);
		expect(blocks[0]?.tokenCounts.outputTokens).toBe(1500);
		expect(blocks[0]?.costUSD).toBe(0.03);
	});

	test('creates multiple blocks when entries span more than 5 hours', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [
			createMockEntry(baseTime),
			createMockEntry(new Date(baseTime.getTime() + 6 * 60 * 60 * 1000)), // 6 hours later
		];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks).toHaveLength(3); // first block, gap block, second block
		expect(blocks[0]?.entries).toHaveLength(1);
		expect(blocks[1]?.isGap).toBe(true); // gap block
		expect(blocks[2]?.entries).toHaveLength(1);
	});

	test('creates gap block when there is a gap longer than 5 hours', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [
			createMockEntry(baseTime),
			createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
			createMockEntry(new Date(baseTime.getTime() + 8 * 60 * 60 * 1000)), // 8 hours later
		];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks).toHaveLength(3); // first block, gap block, second block
		expect(blocks[0]?.entries).toHaveLength(2);
		expect(blocks[1]?.isGap).toBe(true);
		expect(blocks[1]?.entries).toHaveLength(0);
		expect(blocks[2]?.entries).toHaveLength(1);
	});

	test('sorts entries by timestamp before processing', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [
			createMockEntry(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)), // 2 hours later
			createMockEntry(baseTime), // earlier
			createMockEntry(new Date(baseTime.getTime() + 1 * 60 * 60 * 1000)), // 1 hour later
		];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.entries[0]?.timestamp).toEqual(baseTime);
		expect(blocks[0]?.entries[1]?.timestamp).toEqual(new Date(baseTime.getTime() + 1 * 60 * 60 * 1000));
		expect(blocks[0]?.entries[2]?.timestamp).toEqual(new Date(baseTime.getTime() + 2 * 60 * 60 * 1000));
	});

	test('aggregates different models correctly', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [
			createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514'),
			createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000), 2000, 1000, 'claude-opus-4-20250514'),
		];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.models).toEqual(['claude-sonnet-4-20250514', 'claude-opus-4-20250514']);
	});

	test('handles null costUSD correctly', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [
			createMockEntry(baseTime, 1000, 500, 'claude-sonnet-4-20250514', 0.01),
			{ ...createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000)), costUSD: null },
		];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.costUSD).toBe(0.01); // Only the first entry's cost
	});

	test('sets correct block ID as ISO string', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [createMockEntry(baseTime)];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks[0]?.id).toBe(baseTime.toISOString());
	});

	test('sets correct endTime as startTime + 5 hours', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const entries: LoadedUsageEntry[] = [createMockEntry(baseTime)];

		const blocks = identifyFiveHourBlocks(entries);
		expect(blocks[0]?.endTime).toEqual(new Date(baseTime.getTime() + FIVE_HOURS_MS));
	});

	test('handles cache tokens correctly', () => {
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

		const blocks = identifyFiveHourBlocks([entry]);
		expect(blocks[0]?.tokenCounts.cacheCreationInputTokens).toBe(100);
		expect(blocks[0]?.tokenCounts.cacheReadInputTokens).toBe(200);
	});
});

describe('calculateBurnRate', () => {
	test('returns null for empty entries', () => {
		const block: FiveHourBlock = {
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

	test('returns null for gap blocks', () => {
		const block: FiveHourBlock = {
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

	test('returns null when duration is zero or negative', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const block: FiveHourBlock = {
			id: baseTime.toISOString(),
			startTime: baseTime,
			endTime: new Date(baseTime.getTime() + FIVE_HOURS_MS),
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

	test('calculates burn rate correctly', () => {
		const baseTime = new Date('2024-01-01T10:00:00Z');
		const laterTime = new Date(baseTime.getTime() + 60 * 1000); // 1 minute later
		const block: FiveHourBlock = {
			id: baseTime.toISOString(),
			startTime: baseTime,
			endTime: new Date(baseTime.getTime() + FIVE_HOURS_MS),
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
	test('returns null for inactive blocks', () => {
		const block: FiveHourBlock = {
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

	test('returns null for gap blocks', () => {
		const block: FiveHourBlock = {
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

	test('returns null when burn rate cannot be calculated', () => {
		const block: FiveHourBlock = {
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

	test('projects usage correctly for active block', () => {
		const now = new Date();
		const startTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
		const endTime = new Date(startTime.getTime() + FIVE_HOURS_MS);
		const pastTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 minutes after start

		const block: FiveHourBlock = {
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
	test('filters blocks correctly with default 3 days', () => {
		const now = new Date();
		const recentTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
		const oldTime = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

		const blocks: FiveHourBlock[] = [
			{
				id: recentTime.toISOString(),
				startTime: recentTime,
				endTime: new Date(recentTime.getTime() + FIVE_HOURS_MS),
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
				endTime: new Date(oldTime.getTime() + FIVE_HOURS_MS),
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

	test('includes active blocks regardless of age', () => {
		const now = new Date();
		const oldTime = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

		const blocks: FiveHourBlock[] = [
			{
				id: oldTime.toISOString(),
				startTime: oldTime,
				endTime: new Date(oldTime.getTime() + FIVE_HOURS_MS),
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

	test('supports custom days parameter', () => {
		const now = new Date();
		const withinCustomRange = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
		const outsideCustomRange = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

		const blocks: FiveHourBlock[] = [
			{
				id: withinCustomRange.toISOString(),
				startTime: withinCustomRange,
				endTime: new Date(withinCustomRange.getTime() + FIVE_HOURS_MS),
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
				endTime: new Date(outsideCustomRange.getTime() + FIVE_HOURS_MS),
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

	test('returns empty array when no blocks match criteria', () => {
		const now = new Date();
		const oldTime = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

		const blocks: FiveHourBlock[] = [
			{
				id: oldTime.toISOString(),
				startTime: oldTime,
				endTime: new Date(oldTime.getTime() + FIVE_HOURS_MS),
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
