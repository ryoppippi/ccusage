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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { CLAUDE_PROJECTS_DIR_NAME, USAGE_DATA_GLOB_PATTERN } from './_consts.ts';
import { identifySessionBlocks } from './_session-blocks.ts';
import {
	calculateCostForEntry,
	createUniqueHash,
	getEarliestTimestamp,
	sortFilesByTimestamp,
	usageDataSchema,
} from './data-loader.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

/**
 * Configuration for live monitoring
 */
export type LiveMonitorConfig = {
	claudePath: string;
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
		const claudeDir = path.join(this.config.claudePath, CLAUDE_PROJECTS_DIR_NAME);
		const files = await glob([USAGE_DATA_GLOB_PATTERN], {
			cwd: claudeDir,
			absolute: true,
		});

		if (files.length === 0) {
			return null;
		}

		// Check for new or modified files
		const filesToRead: string[] = [];
		for (const file of files) {
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
				const content = await readFile(file, 'utf-8')
					.catch(() => {
						// Skip files that can't be read
						return '';
					});

				const lines = content
					.trim()
					.split('\n')
					.filter(line => line.length > 0);

				for (const line of lines) {
					try {
						const parsed = JSON.parse(line) as unknown;
						const result = usageDataSchema.safeParse(parsed);
						if (!result.success) {
							continue;
						}
						const data = result.data;

						// Check for duplicates
						const uniqueHash = createUniqueHash(data);
						if (uniqueHash != null && this.processedHashes.has(uniqueHash)) {
							continue;
						}
						if (uniqueHash != null) {
							this.processedHashes.add(uniqueHash);
						}

						// Calculate cost if needed
						const costUSD: number = await (this.config.mode === 'display'
							? Promise.resolve(data.costUSD ?? 0)
							: calculateCostForEntry(
									data,
									this.config.mode,
									this.fetcher!,
								));

						// Add entry
						this.allEntries.push({
							timestamp: new Date(data.timestamp),
							usage: {
								inputTokens: data.message.usage.input_tokens ?? 0,
								outputTokens: data.message.usage.output_tokens ?? 0,
								cacheCreationInputTokens: data.message.usage.cache_creation_input_tokens ?? 0,
								cacheReadInputTokens: data.message.usage.cache_read_input_tokens ?? 0,
							},
							costUSD,
							model: data.message.model ?? '<synthetic>',
							version: data.version,
						});
					}
					catch {
						// Skip malformed lines
					}
				}
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
				claudePath: tempDir,
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
				claudePath: emptyFixture.path,
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
