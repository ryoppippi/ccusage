/**
 * @fileoverview Live monitoring implementation for Claude usage data
 *
 * This module provides efficient incremental data loading for the live monitoring feature
 * in the blocks command. It tracks file modifications and only reads changed data,
 * maintaining a cache of processed entries to minimize file I/O during live updates.
 *
 * Used exclusively by blocks-live.ts for the --live flag functionality.
 */

import type { LoadedUsageEntry, SessionBlock } from './_session-blocks.ts';
import type { CostMode, SortOrder } from './_types.ts';
import { readFile, stat } from 'node:fs/promises';
import { Result } from '@praha/byethrow';
import pLimit from 'p-limit';
import { identifySessionBlocks } from './_session-blocks.ts';
import {
	calculateCostForEntry,
	createUniqueHash,
	getEarliestTimestamp,
	getUsageLimitResetTime,
	globUsageFiles,
	sortFilesByTimestamp,
	usageDataSchema,
} from './data-loader.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

/**
 * Configuration for live monitoring
 */
export type LiveMonitorConfig = {
	claudePaths: string[];
	sessionDurationHours: number;
	mode: CostMode;
	order: SortOrder;
};

/**
 * State for live monitoring operations
 */
type LiveMonitorState = {
	fetcher: PricingFetcher | null;
	lastFileTimestamps: Map<string, number>;
	processedHashes: Set<string>;
	allEntries: LoadedUsageEntry[];
	[Symbol.dispose]: () => void;
};

/**
 * Constants for live monitoring
 */
const RETENTION_HOURS = 24;
const FILE_CONCURRENCY = 5;

/**
 * Fast file filtering using file stats instead of reading contents
 * This is a performance optimization for live monitoring only
 */
async function isRecentFile(filePath: string, cutoffTime: Date): Promise<boolean> {
	return Result.pipe(
		Result.try({
			try: stat(filePath),
			catch: error => error,
		}),
		Result.map(fileStats => fileStats.mtime >= cutoffTime),
		Result.unwrap(false),
	);
}

/**
 * Creates a new live monitoring state
 */
export function createLiveMonitorState(config: LiveMonitorConfig): LiveMonitorState {
	const fetcher = config.mode !== 'display' ? new PricingFetcher() : null;

	return {
		fetcher,
		lastFileTimestamps: new Map<string, number>(),
		processedHashes: new Set<string>(),
		allEntries: [],
		[Symbol.dispose](): void {
			fetcher?.[Symbol.dispose]();
		},
	};
}

/**
 * Clears all cached data from the state
 */
export function clearLiveMonitorCache(state: LiveMonitorState): void {
	state.lastFileTimestamps.clear();
	state.processedHashes.clear();
	state.allEntries = [];
}

/**
 * Removes entries older than the cutoff time to manage memory usage
 */
function cleanupOldEntries(state: LiveMonitorState, cutoffTime: Date): void {
	const initialCount = state.allEntries.length;
	state.allEntries = state.allEntries.filter(entry => entry.timestamp >= cutoffTime);

	// If we removed a significant number of entries, clear processed hashes to avoid stale references
	if (initialCount - state.allEntries.length > 100) {
		state.processedHashes.clear();
	}
}

/**
 * Processes file content and adds valid entries within the retention window
 */
async function processFileContent(
	state: LiveMonitorState,
	config: LiveMonitorConfig,
	content: string,
	cutoffTime: Date,
): Promise<void> {
	const lines = content
		.trim()
		.split('\n')
		.filter(line => line.length > 0);

	for (const line of lines) {
		const dataResult = Result.pipe(
			Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: error => error,
			})(),
			Result.andThen((data) => {
				const parseResult = usageDataSchema.safeParse(data);
				return parseResult.success
					? Result.succeed(parseResult.data)
					: Result.fail(parseResult.error);
			}),
		);

		if (Result.isFailure(dataResult)) {
			continue; // Skip malformed JSON lines or validation failures
		}

		const data = Result.unwrap(dataResult);

		// Only process entries within retention window
		const entryTime = new Date(data.timestamp);
		if (entryTime < cutoffTime) {
			continue;
		}

		// Check for duplicates
		const uniqueHash = createUniqueHash(data);
		if (uniqueHash != null && state.processedHashes.has(uniqueHash)) {
			continue;
		}
		if (uniqueHash != null) {
			state.processedHashes.add(uniqueHash);
		}

		// Calculate cost if needed
		const costUSD: number = await (config.mode === 'display'
			? Promise.resolve(data.costUSD ?? 0)
			: calculateCostForEntry(
					data,
					config.mode,
					state.fetcher!,
				));

		const usageLimitResetTime = getUsageLimitResetTime(data);

		// Add entry
		state.allEntries.push({
			timestamp: entryTime,
			usage: {
				inputTokens: data.message.usage.input_tokens ?? 0,
				outputTokens: data.message.usage.output_tokens ?? 0,
				cacheCreationInputTokens: data.message.usage.cache_creation_input_tokens ?? 0,
				cacheReadInputTokens: data.message.usage.cache_read_input_tokens ?? 0,
			},
			costUSD,
			model: data.message.model ?? '<synthetic>',
			version: data.version,
			usageLimitResetTime: usageLimitResetTime ?? undefined,
		});
	}
}

/**
 * Gets the current active session block with minimal file reading
 * Only reads new or modified files since last check
 */
export async function getActiveBlock(
	state: LiveMonitorState,
	config: LiveMonitorConfig,
): Promise<SessionBlock | null> {
	const cutoffTime = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);
	const results = await globUsageFiles(config.claudePaths);
	const allFiles = results.map(r => r.file);

	if (allFiles.length === 0) {
		return null;
	}

	// Filter files by modification time first (fast coarse filter)
	const candidateFiles: string[] = [];
	for (const file of allFiles) {
		if (await isRecentFile(file, cutoffTime)) {
			candidateFiles.push(file);
		}
	}

	// Check for new or modified files among candidates
	const filesToRead: string[] = [];
	for (const file of candidateFiles) {
		const timestamp = await getEarliestTimestamp(file);
		const lastTimestamp = state.lastFileTimestamps.get(file);

		if (timestamp != null && (lastTimestamp == null || timestamp.getTime() > lastTimestamp)) {
			filesToRead.push(file);
			state.lastFileTimestamps.set(file, timestamp.getTime());
		}
	}

	// Remove old entries from cache
	cleanupOldEntries(state, cutoffTime);

	// Read files with controlled concurrency
	if (filesToRead.length > 0) {
		const sortedFiles = await sortFilesByTimestamp(filesToRead);
		const fileLimit = pLimit(FILE_CONCURRENCY);

		// Process files concurrently with p-limit
		const fileResults = await Promise.allSettled(
			sortedFiles.map(async file =>
				fileLimit(async () => ({
					file,
					content: await readFile(file, 'utf-8'),
				})),
			),
		);

		// Process successful file reads
		for (const result of fileResults) {
			if (result.status === 'fulfilled') {
				const { content } = result.value;
				await processFileContent(state, config, content, cutoffTime);
			}
		}
	}

	// Generate blocks and find active one
	const blocks = identifySessionBlocks(
		state.allEntries,
		config.sessionDurationHours,
	);

	// Sort blocks
	const sortedBlocks = config.order === 'asc'
		? blocks
		: blocks.reverse();

	// Find active block
	return sortedBlocks.find(block => block.isActive) ?? null;
}

if (import.meta.vitest != null) {
	describe('LiveMonitor functions', () => {
		let tempDir: string;
		let state: LiveMonitorState;
		let config: LiveMonitorConfig;

		beforeEach(async () => {
			const { createFixture } = await import('fs-fixture');
			const now = new Date();
			const recentTimestamp = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

			const fixture = await createFixture({
				'projects/test-project/session1/usage.jsonl': `${JSON.stringify({
					timestamp: recentTimestamp.toISOString(),
					message: {
						model: 'claude-sonnet-4-20250514',
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
					costUSD: 0.01,
					version: '1.0.0',
				})}\n`,
			});
			tempDir = fixture.path;

			config = {
				claudePaths: [tempDir],
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
			};

			state = createLiveMonitorState(config);
		});

		it('should initialize and handle clearing cache', async () => {
			// Test initial state by calling getActiveBlock which should work
			const initialBlock = await getActiveBlock(state, config);
			expect(initialBlock).not.toBeNull();

			// Clear cache and test again
			clearLiveMonitorCache(state);
			const afterClearBlock = await getActiveBlock(state, config);
			expect(afterClearBlock).not.toBeNull();
		});

		it('should load and process usage data', async () => {
			const activeBlock = await getActiveBlock(state, config);

			expect(activeBlock).not.toBeNull();
			if (activeBlock != null) {
				expect(activeBlock.tokenCounts.inputTokens).toBe(100);
				expect(activeBlock.tokenCounts.outputTokens).toBe(50);
				expect(activeBlock.costUSD).toBe(0.01);
				expect(activeBlock.models).toContain('claude-sonnet-4-20250514');
			}
		});

		it('should handle empty directories', async () => {
			const { createFixture } = await import('fs-fixture');
			const emptyFixture = await createFixture({});

			const emptyConfig = {
				claudePaths: [emptyFixture.path],
				sessionDurationHours: 5,
				mode: 'display' as const,
				order: 'desc' as const,
			};

			using emptyState = createLiveMonitorState(emptyConfig);

			const activeBlock = await getActiveBlock(emptyState, emptyConfig);
			expect(activeBlock).toBeNull();
		});
	});
}
