import {
	calculateBurnRate,
	filterRecentBlocks,
	identifySessionBlocks,
	type LoadedUsageEntry,
	projectBlockUsage,
	type SessionBlock,
} from './session-blocks.internal.ts';

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
