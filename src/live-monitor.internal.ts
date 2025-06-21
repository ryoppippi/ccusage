/**
 * @fileoverview Live monitoring implementation for Claude usage data
 *
 * This module provides efficient incremental data loading for the live monitoring feature
 * in the blocks command. It tracks file modifications and only reads changed data,
 * maintaining a cache of processed entries to minimize file I/O during live updates.
 *
 * Used exclusively by blocks-live.ts for the --live flag functionality.
 */

import type { CostMode, SortOrder } from './types.internal.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { CLAUDE_PROJECTS_DIR_NAME, USAGE_DATA_GLOB_PATTERN } from './consts.internal.js';
import {
	calculateCostForEntry,
	createUniqueHash,
	getEarliestTimestamp,
	sortFilesByTimestamp,
	usageDataSchema,
} from './data-loader.ts';
import { PricingFetcher } from './pricing-fetcher.ts';
import {
	identifySessionBlocks,
	type LoadedUsageEntry,
	type SessionBlock,
} from './session-blocks.internal.ts';

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
				const content = await readFile(file, 'utf-8');
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
