import type { CodexLoadedUsageEntry } from './_block-entry.ts';

export const DEFAULT_SESSION_DURATION_HOURS = 5;
export const DEFAULT_RECENT_DAYS = 3;

export type CodexSessionBlock = {
	id: string;
	startTime: Date;
	endTime: Date;
	actualEndTime?: Date;
	isActive: boolean;
	isGap?: boolean;
	entries: CodexLoadedUsageEntry[];
	tokenCounts: {
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens: number;
		reasoningOutputTokens: number;
		totalTokens: number;
	};
	costUSD: number;
	models: string[];
};

export function identifyCodexSessionBlocks(
	entries: CodexLoadedUsageEntry[],
	sessionDurationHours: number = DEFAULT_SESSION_DURATION_HOURS,
): CodexSessionBlock[] {
	if (entries.length === 0) {
		return [];
	}

	const sortedEntries = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
	const sessionDurationMs = sessionDurationHours * 60 * 60 * 1000;
	const now = new Date();
	const blocks: CodexSessionBlock[] = [];

	let currentBlockStart: Date | null = null;
	let currentBlockEntries: CodexLoadedUsageEntry[] = [];

	for (const entry of sortedEntries) {
		if (currentBlockStart == null) {
			currentBlockStart = floorToHour(entry.timestamp);
			currentBlockEntries = [entry];
			continue;
		}

		const timeSinceBlockStart = entry.timestamp.getTime() - currentBlockStart.getTime();
		const previousEntry = currentBlockEntries.at(-1);
		const timeSincePrevious = previousEntry == null ? 0 : entry.timestamp.getTime() - previousEntry.timestamp.getTime();

		if (timeSinceBlockStart > sessionDurationMs || timeSincePrevious > sessionDurationMs) {
			blocks.push(createBlock(currentBlockStart, currentBlockEntries, sessionDurationMs, now));

			if (previousEntry != null && timeSincePrevious > sessionDurationMs) {
				const gap = createGapBlock(previousEntry.timestamp, entry.timestamp, sessionDurationMs);
				if (gap != null) {
					blocks.push(gap);
				}
			}

			currentBlockStart = floorToHour(entry.timestamp);
			currentBlockEntries = [entry];
		}
		else {
			currentBlockEntries.push(entry);
		}
	}

	if (currentBlockStart != null && currentBlockEntries.length > 0) {
		blocks.push(createBlock(currentBlockStart, currentBlockEntries, sessionDurationMs, now));
	}

	return blocks;
}

function floorToHour(timestamp: Date): Date {
	const floored = new Date(timestamp);
	floored.setUTCMinutes(0, 0, 0);
	return floored;
}

function createBlock(
	startTime: Date,
	entries: CodexLoadedUsageEntry[],
	sessionDurationMs: number,
	now: Date,
): CodexSessionBlock {
	const endTime = new Date(startTime.getTime() + sessionDurationMs);
	const actualEndTime = entries.at(-1)?.timestamp ?? startTime;
	const isActive = now.getTime() - actualEndTime.getTime() < sessionDurationMs && now < endTime;

	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	let reasoningOutputTokens = 0;
	let totalTokens = 0;
	let costUSD = 0;
	const models: string[] = [];

	for (const entry of entries) {
		inputTokens += entry.usage.inputTokens;
		outputTokens += entry.usage.outputTokens;
		cachedInputTokens += entry.usage.cachedInputTokens;
		reasoningOutputTokens += entry.usage.reasoningOutputTokens;
		totalTokens += entry.usage.totalTokens;
		costUSD += entry.costUSD;
		models.push(entry.model);
	}

	return {
		id: startTime.toISOString(),
		startTime,
		endTime,
		actualEndTime,
		isActive,
		entries,
		tokenCounts: {
			inputTokens,
			outputTokens,
			cachedInputTokens,
			reasoningOutputTokens,
			totalTokens,
		},
		costUSD,
		models: Array.from(new Set(models)),
	};
}

function createGapBlock(
	lastActivityTime: Date,
	nextActivityTime: Date,
	sessionDurationMs: number,
): CodexSessionBlock | null {
	const gapDuration = nextActivityTime.getTime() - lastActivityTime.getTime();
	if (gapDuration <= sessionDurationMs) {
		return null;
	}

	const startTime = new Date(lastActivityTime.getTime() + sessionDurationMs);
	return {
		id: `gap-${startTime.toISOString()}`,
		startTime,
		endTime: nextActivityTime,
		isActive: false,
		isGap: true,
		entries: [],
		tokenCounts: {
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens: 0,
		},
		costUSD: 0,
		models: [],
	};
}

export type CodexBlockBurnRate = {
	tokensPerMinute: number;
	tokensPerMinuteForIndicator: number;
	costPerHour: number;
};

export type CodexBlockProjection = {
	totalTokens: number;
	totalCost: number;
	remainingMinutes: number;
};

export function calculateBurnRate(block: CodexSessionBlock): CodexBlockBurnRate | null {
	if (block.entries.length === 0 || block.isGap === true) {
		return null;
	}

	const first = block.entries[0];
	const last = block.entries[block.entries.length - 1];
	if (first == null || last == null) {
		return null;
	}

	const durationMinutes = (last.timestamp.getTime() - first.timestamp.getTime()) / (1000 * 60);
	if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
		return null;
	}

	const totalTokens = block.tokenCounts.totalTokens;
	const tokensPerMinute = totalTokens / durationMinutes;
	const tokensPerMinuteForIndicator = (block.tokenCounts.inputTokens + block.tokenCounts.outputTokens) / durationMinutes;
	const costPerHour = (block.costUSD / durationMinutes) * 60;

	return {
		tokensPerMinute,
		tokensPerMinuteForIndicator,
		costPerHour,
	};
}

export function projectBlockUsage(block: CodexSessionBlock): CodexBlockProjection | null {
	if (!block.isActive || block.isGap === true) {
		return null;
	}

	const burnRate = calculateBurnRate(block);
	if (burnRate == null) {
		return null;
	}

	const now = new Date();
	const remainingMinutes = Math.max(0, (block.endTime.getTime() - now.getTime()) / (1000 * 60));
	if (remainingMinutes <= 0) {
		return null;
	}

	const projectedTokens = block.tokenCounts.totalTokens + burnRate.tokensPerMinute * remainingMinutes;
	const projectedCost = block.costUSD + (burnRate.costPerHour / 60) * remainingMinutes;

	return {
		totalTokens: Math.round(projectedTokens),
		totalCost: Math.round(projectedCost * 100) / 100,
		remainingMinutes: Math.round(remainingMinutes),
	};
}

export function filterRecentBlocks(blocks: CodexSessionBlock[], days = DEFAULT_RECENT_DAYS): CodexSessionBlock[] {
	const now = new Date();
	const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return blocks.filter(block => block.isActive || block.startTime >= cutoff);
}

if (import.meta.vitest != null) {
	function createEntry(timestamp: string, overrides: Partial<CodexLoadedUsageEntry> = {}): CodexLoadedUsageEntry {
		return {
			timestamp: new Date(timestamp),
			sessionId: 'session-1',
			model: 'gpt-5',
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cachedInputTokens: 10,
				reasoningOutputTokens: 5,
				totalTokens: 150,
			},
			costUSD: 0.1,
			...overrides,
		};
	}

	describe('identifyCodexSessionBlocks', () => {
		it('returns an empty array when no entries are provided', () => {
			const blocks = identifyCodexSessionBlocks([]);
			expect(blocks).toEqual([]);
		});

		it('groups entries that fall within the session duration into one block', () => {
			const entries = [
				createEntry('2025-10-05T00:00:00.000Z'),
				createEntry('2025-10-05T02:00:00.000Z'),
			];
			const blocks = identifyCodexSessionBlocks(entries);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]?.entries).toHaveLength(2);
			expect(blocks[0]?.tokenCounts.inputTokens).toBe(200);
			expect(blocks[0]?.costUSD).toBeCloseTo(0.2);
		});

		it('creates a new block and a gap block when entries exceed the session duration', () => {
			const entries = [
				createEntry('2025-10-05T00:00:00.000Z'),
				createEntry('2025-10-05T06:30:00.000Z'),
			];
			const blocks = identifyCodexSessionBlocks(entries);
			expect(blocks).toHaveLength(3);
			expect(blocks[1]?.isGap).toBe(true);
		});

		it('deduplicates the model list for each block', () => {
			const entries = [
				createEntry('2025-10-05T00:00:00.000Z', { model: 'gpt-5' }),
				createEntry('2025-10-05T01:00:00.000Z', { model: 'gpt-5-mini' }),
				createEntry('2025-10-05T01:30:00.000Z', { model: 'gpt-5' }),
			];
			const blocks = identifyCodexSessionBlocks(entries);
			expect(blocks[0]?.models).toEqual(['gpt-5', 'gpt-5-mini']);
		});
	});

	describe('calculateBurnRate', () => {
		it('returns null for empty blocks or gap blocks', () => {
			const emptyBlock: CodexSessionBlock = {
				id: 'block-empty',
				startTime: new Date('2025-10-05T00:00:00.000Z'),
				endTime: new Date('2025-10-05T05:00:00.000Z'),
				isActive: false,
				entries: [],
				tokenCounts: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
				costUSD: 0,
				models: [],
			};
			expect(calculateBurnRate(emptyBlock)).toBeNull();

			const gapBlock: CodexSessionBlock = { ...emptyBlock, id: 'gap', isGap: true };
			expect(calculateBurnRate(gapBlock)).toBeNull();
		});

		it('calculates burn rate metrics from token usage and cost', () => {
			const start = new Date('2025-10-05T00:00:00.000Z');
			const later = new Date('2025-10-05T01:00:00.000Z');
			const block = identifyCodexSessionBlocks([
				createEntry(start.toISOString()),
				createEntry(later.toISOString()),
			])[0]!;
			const burnRate = calculateBurnRate(block);
			expect(burnRate).not.toBeNull();
			expect(burnRate?.tokensPerMinute).toBeGreaterThan(0);
			expect(burnRate?.costPerHour).toBeGreaterThan(0);
		});
	});

	describe('projectBlockUsage', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2025-10-05T02:30:00.000Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('returns null for inactive blocks or gap blocks', () => {
			const block = identifyCodexSessionBlocks([
				createEntry('2025-10-05T00:00:00.000Z'),
			])[0]!;
			block.isActive = false;
			expect(projectBlockUsage(block)).toBeNull();

			const gapBlock: CodexSessionBlock = { ...block, isActive: true, isGap: true };
			expect(projectBlockUsage(gapBlock)).toBeNull();
		});

		it('projects remaining usage for active blocks', () => {
			const start = new Date('2025-10-05T00:00:00.000Z');
			const later = new Date('2025-10-05T01:00:00.000Z');
			const block = identifyCodexSessionBlocks([
				createEntry(start.toISOString()),
				createEntry(later.toISOString()),
			])[0]!;
			block.isActive = true;
			const projection = projectBlockUsage(block);
			expect(projection).not.toBeNull();
			expect(projection?.totalTokens).toBeGreaterThan(block.tokenCounts.totalTokens);
		});
	});

	describe('filterRecentBlocks', () => {
		it('keeps only recent blocks or those still active', () => {
			const now = new Date();
			const mk = (id: string, offsetDays: number, isActive = false): CodexSessionBlock => ({
				id,
				startTime: new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000),
				endTime: new Date(now.getTime() - (offsetDays - 0.5) * 24 * 60 * 60 * 1000),
				isActive,
				entries: [],
				tokenCounts: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
				costUSD: 0,
				models: [],
			});

			const recent = mk('recent', 1);
			const old = mk('old', 10);
			const active = mk('active', 8, true);

			const filtered = filterRecentBlocks([recent, old, active], 3);
			expect(filtered).toEqual([recent, active]);
		});
	});
}
