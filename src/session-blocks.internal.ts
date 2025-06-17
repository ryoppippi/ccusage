const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;
const DEFAULT_RECENT_DAYS = 3;

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

export type TokenCounts = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
};

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

export type BurnRate = {
	tokensPerMinute: number;
	costPerHour: number;
};

export type ProjectedUsage = {
	totalTokens: number;
	totalCost: number;
	remainingMinutes: number;
};

export function identifySessionBlocks(entries: LoadedUsageEntry[]): SessionBlock[] {
	if (entries.length === 0) {
		return [];
	}

	const blocks: SessionBlock[] = [];
	const sortedEntries = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

	let currentBlockStart: Date | null = null;
	let currentBlockEntries: LoadedUsageEntry[] = [];
	const now = new Date();

	for (const entry of sortedEntries) {
		const entryTime = entry.timestamp;

		if (currentBlockStart == null) {
			// First entry - start a new block
			currentBlockStart = entryTime;
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

			if (timeSinceBlockStart > SESSION_DURATION_MS || timeSinceLastEntry > SESSION_DURATION_MS) {
				// Close current block
				const block = createBlock(currentBlockStart, currentBlockEntries, now);
				blocks.push(block);

				// Add gap block if there's a significant gap
				if (timeSinceLastEntry > SESSION_DURATION_MS) {
					const gapBlock = createGapBlock(lastEntryTime, entryTime);
					if (gapBlock != null) {
						blocks.push(gapBlock);
					}
				}

				// Start new block
				currentBlockStart = entryTime;
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
		const block = createBlock(currentBlockStart, currentBlockEntries, now);
		blocks.push(block);
	}

	return blocks;
}

function createBlock(startTime: Date, entries: LoadedUsageEntry[], now: Date): SessionBlock {
	const endTime = new Date(startTime.getTime() + SESSION_DURATION_MS);
	const lastEntry = entries[entries.length - 1];
	const actualEndTime = lastEntry != null ? lastEntry.timestamp : startTime;
	const isActive = now.getTime() - actualEndTime.getTime() < SESSION_DURATION_MS && now < endTime;

	// Aggregate token counts
	const tokenCounts: TokenCounts = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
	};

	let costUSD = 0;
	const modelsSet = new Set<string>();

	for (const entry of entries) {
		tokenCounts.inputTokens += entry.usage.inputTokens;
		tokenCounts.outputTokens += entry.usage.outputTokens;
		tokenCounts.cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
		tokenCounts.cacheReadInputTokens += entry.usage.cacheReadInputTokens;
		costUSD += entry.costUSD != null ? entry.costUSD : 0;
		modelsSet.add(entry.model);
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
		models: Array.from(modelsSet),
	};
}

function createGapBlock(lastActivityTime: Date, nextActivityTime: Date): SessionBlock | null {
	// Only create gap blocks for gaps longer than 5 hours
	const gapDuration = nextActivityTime.getTime() - lastActivityTime.getTime();
	if (gapDuration <= SESSION_DURATION_MS) {
		return null;
	}

	const gapStart = new Date(lastActivityTime.getTime() + SESSION_DURATION_MS);
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

	return {
		tokensPerMinute,
		costPerHour,
	};
}

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

export function filterRecentBlocks(blocks: SessionBlock[], days: number = DEFAULT_RECENT_DAYS): SessionBlock[] {
	const now = new Date();
	const cutoffTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

	return blocks.filter((block) => {
		// Include block if it started after cutoff or if it's still active
		return block.startTime >= cutoffTime || block.isActive;
	});
}
