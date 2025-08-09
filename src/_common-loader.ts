/**
 * @fileoverview Common data loading utilities for reducing code duplication
 * @internal
 */

import type { CostMode } from './_types.ts';
import type { UsageData } from './data-loader.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toArray } from '@antfu/utils';
import { glob } from 'tinyglobby';
import { CLAUDE_PROJECTS_DIR_NAME, USAGE_DATA_GLOB_PATTERN } from './_consts.ts';
import { calculateCostForEntry, createUniqueHash, extractProjectFromPath, getClaudePaths, sortFilesByTimestamp, usageDataSchema } from './data-loader.ts';
import { logger } from './logger.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

/**
 * Options for loading usage data
 */
export type CommonLoadOptions = {
	claudePath?: string | string[];
	project?: string;
	mode?: CostMode;
	offline?: boolean;
};

/**
 * Processed entry with common fields
 */
export type ProcessedEntry = {
	data: UsageData;
	file: string;
	cost: number;
	model: string | undefined;
};

/**
 * File with base directory for relative path calculations
 */
export type FileWithBase = {
	file: string;
	baseDir: string;
};

/**
 * Common data loader that handles file collection, parsing, and deduplication
 */
export async function loadCommonUsageData(
	options?: CommonLoadOptions,
): Promise<{ entries: ProcessedEntry[]; filesWithBase: FileWithBase[] }> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths with their base directories
	const filesWithBase = await globUsageFiles(claudePaths);

	if (filesWithBase.length === 0) {
		return { entries: [], filesWithBase: [] };
	}

	// Filter by project if specified
	const projectFilteredWithBase = filterFilesByProject(
		filesWithBase,
		item => extractProjectFromPath(item.file),
		options?.project,
	);

	// Sort files by timestamp to ensure chronological processing
	const fileToBaseMap = new Map(projectFilteredWithBase.map(f => [f.file, f.baseDir]));
	const sortedFilesWithBase = await sortFilesByTimestamp(
		projectFilteredWithBase.map(f => f.file),
	).then(sortedFiles =>
		sortedFiles.map(file => ({
			file,
			baseDir: fileToBaseMap.get(file) ?? '',
		})),
	);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

	// Track processed message+request combinations for deduplication
	const processedHashes = new Set<string>();

	// Collect all valid data entries
	const allEntries: ProcessedEntry[] = [];

	for (const { file } of sortedFilesWithBase) {
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

				// Check for duplicate message + request ID combination
				const uniqueHash = createUniqueHash(data);
				if (isDuplicateEntry(uniqueHash, processedHashes)) {
					// Skip duplicate message
					continue;
				}

				// Mark this combination as processed
				markAsProcessed(uniqueHash, processedHashes);

				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({
					data,
					file,
					cost,
					model: data.message.model,
				});
			}
			catch (error) {
				// Skip invalid JSON lines but log for debugging
				logger.debug(`Skipping invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	return { entries: allEntries, filesWithBase: sortedFilesWithBase };
}

/**
 * Globs usage files from multiple Claude paths
 */
export async function globUsageFiles(claudePaths: string[]): Promise<FileWithBase[]> {
	const filesWithBase: FileWithBase[] = [];

	for (const claudePath of claudePaths) {
		const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
		const files = await glob([USAGE_DATA_GLOB_PATTERN], {
			cwd: claudeDir,
			absolute: true,
		});

		for (const file of files) {
			filesWithBase.push({ file, baseDir: claudeDir });
		}
	}

	return filesWithBase;
}

/**
 * Filters files by project name
 */
function filterFilesByProject<T>(
	items: T[],
	getProject: (item: T) => string | undefined,
	projectFilter?: string,
): T[] {
	if (projectFilter == null) {
		return items;
	}

	return items.filter((item) => {
		const projectName = getProject(item);
		return projectName === projectFilter;
	});
}

/**
 * Checks if an entry is a duplicate based on hash
 */
function isDuplicateEntry(
	uniqueHash: string | null,
	processedHashes: Set<string>,
): boolean {
	if (uniqueHash == null) {
		return false;
	}
	return processedHashes.has(uniqueHash);
}

/**
 * Marks an entry as processed
 */
function markAsProcessed(
	uniqueHash: string | null,
	processedHashes: Set<string>,
): void {
	if (uniqueHash != null) {
		processedHashes.add(uniqueHash);
	}
}
