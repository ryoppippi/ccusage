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
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
 * Manages live monitoring of Claude usage with efficient data reloading
 */
export class LiveMonitor implements Disposable {
	private config: LiveMonitorConfig;
	private fetcher: PricingFetcher | null = null;
	private lastFileTimestamps = new Map<string, number>();
	private processedHashes = new Set<string>();
	private allEntries: LoadedUsageEntry[] = [];

	constructor(config: LiveMonitorConfig) {
		this.config = config;
		// Initialize pricing fetcher once if needed
		if (config.mode !== 'display') {
			this.fetcher = new PricingFetcher();
		}
	}

	/**
	 * Implements Disposable interface
	 */
	[Symbol.dispose](): void {
		this.fetcher?.[Symbol.dispose]();
	}

	/**
	 * Gets the current active session block with minimal file reading
	 * Only reads new or modified files since last check
	 */
	async getActiveBlock(): Promise<SessionBlock | null> {
		const results = await globUsageFiles(this.config.claudePaths);
		const allFiles = results.map(r => r.file);

		if (allFiles.length === 0) {
			return null;
		}

		// Check for new or modified files
		const filesToRead: string[] = [];
		for (const file of allFiles) {
			const timestamp = await getEarliestTimestamp(file);
			const lastTimestamp = this.lastFileTimestamps.get(file);

			if (timestamp != null && (lastTimestamp == null || timestamp.getTime() > lastTimestamp)) {
				filesToRead.push(file);
				this.lastFileTimestamps.set(file, timestamp.getTime());
			}
		}

		// Read only new/modified files
		if (filesToRead.length > 0) {
			const sortedFiles = await sortFilesByTimestamp(filesToRead);

			for (const file of sortedFiles) {
				await this.processFileStream(file);
			}
		}

		// Generate blocks and find active one
		const blocks = identifySessionBlocks(
			this.allEntries,
			this.config.sessionDurationHours,
		);

		// Sort blocks
		const sortedBlocks = this.config.order === 'asc'
			? blocks
			: blocks.reverse();

		// Find active block
		return sortedBlocks.find(block => block.isActive) ?? null;
	}

	/**
	 * Processes a single file using streaming to avoid memory issues
	 */
	private async processFileStream(file: string): Promise<void> {
		try {
			const fileStream = createReadStream(file);
			const rl = createInterface({
				input: fileStream,
				crlfDelay: Infinity,
			});

			const pendingOperations: Promise<LoadedUsageEntry | undefined>[] = [];

			rl.on('line', (line) => {
				if (line.trim().length === 0) {
					return;
				}

				const operation = (async () => {
					try {
						const parsed = JSON.parse(line) as unknown;
						const result = usageDataSchema.safeParse(parsed);
						if (!result.success) {
							return;
						}
						const usageData = result.data;

						// Check for duplicates
						const uniqueHash = createUniqueHash(usageData);
						if (uniqueHash != null && this.processedHashes.has(uniqueHash)) {
							return;
						}
						if (uniqueHash != null) {
							this.processedHashes.add(uniqueHash);
						}

						// Calculate cost if needed
						const costUSD: number = await (this.config.mode === 'display'
							? Promise.resolve(usageData.costUSD ?? 0)
							: calculateCostForEntry(
									usageData,
									this.config.mode,
									this.fetcher!,
								));

						const usageLimitResetTime = getUsageLimitResetTime(usageData);

						return {
							timestamp: new Date(usageData.timestamp),
							usage: {
								inputTokens: usageData.message.usage.input_tokens ?? 0,
								outputTokens: usageData.message.usage.output_tokens ?? 0,
								cacheCreationInputTokens: usageData.message.usage.cache_creation_input_tokens ?? 0,
								cacheReadInputTokens: usageData.message.usage.cache_read_input_tokens ?? 0,
							},
							costUSD,
							model: usageData.message.model ?? '<synthetic>',
							version: usageData.version,
							usageLimitResetTime: usageLimitResetTime ?? undefined,
						};
					}
					catch {
						// Skip malformed lines
					}
				})();

				pendingOperations.push(operation);
			});

			await once(rl, 'close');
			const entries = (await Promise.all(pendingOperations)).filter((e): e is LoadedUsageEntry => e != null);
			// Add entries
			this.allEntries.push(...entries);
		}
		catch {
			// Skip files that can't be read
		}
	}

	/**
	 * Clears all cached data to force a full reload
	 */
	clearCache(): void {
		this.lastFileTimestamps.clear();
		this.processedHashes.clear();
		this.allEntries = [];
	}
}

if (import.meta.vitest != null) {
	describe('LiveMonitor', () => {
		let tempDir: string;
		let monitor: LiveMonitor;

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

			monitor = new LiveMonitor({
				claudePaths: [tempDir],
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
			});
		});

		afterEach(() => {
			monitor[Symbol.dispose]();
		});

		it('should initialize and handle clearing cache', async () => {
			// Test initial state by calling getActiveBlock which should work
			const initialBlock = await monitor.getActiveBlock();
			expect(initialBlock).not.toBeNull();

			// Clear cache and test again
			monitor.clearCache();
			const afterClearBlock = await monitor.getActiveBlock();
			expect(afterClearBlock).not.toBeNull();
		});

		it('should load and process usage data', async () => {
			const activeBlock = await monitor.getActiveBlock();

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

			const emptyMonitor = new LiveMonitor({
				claudePaths: [emptyFixture.path],
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
			});

			const activeBlock = await emptyMonitor.getActiveBlock();
			expect(activeBlock).toBeNull();

			emptyMonitor[Symbol.dispose]();
		});
	});
}
