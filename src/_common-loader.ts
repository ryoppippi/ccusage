/**
 * @fileoverview Common data loading utilities for reducing code duplication
 * @internal
 */

import type { CostMode } from './_types.ts';
import type { UsageData } from './data-loader.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toArray } from '@antfu/utils';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import { CLAUDE_PROJECTS_DIR_NAME, USAGE_DATA_GLOB_PATTERN } from './_consts.ts';
import { createISOTimestamp, createMessageId, createRequestId } from './_types.ts';
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

if (import.meta.vitest != null) {
	describe('globUsageFiles', () => {
		it('should glob files from multiple paths with base directories', async () => {
			await using fixture1 = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					project1: {
						session1: {
							'chat.jsonl': '{"timestamp": "2024-01-01T00:00:00Z"}',
						},
					},
				},
			});

			await using fixture2 = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					project2: {
						session2: {
							'data.jsonl': '{"timestamp": "2024-01-02T00:00:00Z"}',
						},
					},
				},
			});

			const result = await globUsageFiles([fixture1.path, fixture2.path]);

			expect(result).toHaveLength(2);
			expect(result.some(f => f.file.includes('chat.jsonl'))).toBe(true);
			expect(result.some(f => f.file.includes('data.jsonl'))).toBe(true);
			expect(result[0]?.baseDir).toContain(CLAUDE_PROJECTS_DIR_NAME);
			expect(result[1]?.baseDir).toContain(CLAUDE_PROJECTS_DIR_NAME);
		});

		it('should return empty array when no files found', async () => {
			await using fixture = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					// Empty directory
				},
			});

			const result = await globUsageFiles([fixture.path]);
			expect(result).toHaveLength(0);
		});
	});

	describe('loadCommonUsageData', () => {
		it('should load and parse JSONL files correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
					message: {
						id: createMessageId('msg-1'),
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					requestId: createRequestId('req-1'),
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T01:00:00Z'),
					message: {
						id: createMessageId('msg-2'),
						usage: {
							input_tokens: 200,
							output_tokens: 100,
						},
					},
					requestId: createRequestId('req-2'),
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					project1: {
						session1: {
							'chat.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadCommonUsageData({
				claudePath: fixture.path,
				mode: 'display', // Use display mode to avoid fetching pricing
			});

			expect(result.entries).toHaveLength(2);
			expect(result.entries[0]?.cost).toBe(0.01);
			expect(result.entries[1]?.cost).toBe(0.02);
			expect(result.entries[0]?.data.message.usage.input_tokens).toBe(100);
			expect(result.entries[1]?.data.message.usage.input_tokens).toBe(200);
		});

		it('should handle deduplication correctly', async () => {
			const duplicateData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
					message: {
						id: createMessageId('msg-1'),
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					requestId: createRequestId('req-1'),
					costUSD: 0.01,
				},
				// Duplicate with same message ID and request ID
				{
					timestamp: createISOTimestamp('2024-01-01T01:00:00Z'),
					message: {
						id: createMessageId('msg-1'),
						usage: {
							input_tokens: 200,
							output_tokens: 100,
						},
					},
					requestId: createRequestId('req-1'),
					costUSD: 0.02,
				},
				// Different message ID, should not be deduplicated
				{
					timestamp: createISOTimestamp('2024-01-01T02:00:00Z'),
					message: {
						id: createMessageId('msg-2'),
						usage: {
							input_tokens: 300,
							output_tokens: 150,
						},
					},
					requestId: createRequestId('req-2'),
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					project1: {
						session1: {
							'chat.jsonl': duplicateData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadCommonUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			// Should have 2 entries after deduplication (first and third)
			expect(result.entries).toHaveLength(2);
			expect(result.entries[0]?.data.message.usage.input_tokens).toBe(100);
			expect(result.entries[1]?.data.message.usage.input_tokens).toBe(300);
		});

		it('should filter by project when specified', async () => {
			const project1Data: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
				message: {
					id: createMessageId('msg-1'),
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: createRequestId('req-1'),
				costUSD: 0.01,
			};

			const project2Data: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T01:00:00Z'),
				message: {
					id: createMessageId('msg-2'),
					usage: {
						input_tokens: 200,
						output_tokens: 100,
					},
				},
				requestId: createRequestId('req-2'),
				costUSD: 0.02,
			};

			await using fixture = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					project1: {
						session1: {
							'chat.jsonl': JSON.stringify(project1Data),
						},
					},
					project2: {
						session2: {
							'chat.jsonl': JSON.stringify(project2Data),
						},
					},
				},
			});

			const result = await loadCommonUsageData({
				claudePath: fixture.path,
				project: 'project1',
				mode: 'display',
			});

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.data.message.usage.input_tokens).toBe(100);
			expect(result.filesWithBase).toHaveLength(1);
			expect(result.filesWithBase[0]?.file).toContain('project1');
		});

		it('should handle invalid JSON lines gracefully', async () => {
			const validData: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
				message: {
					id: createMessageId('msg-1'),
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: createRequestId('req-1'),
				costUSD: 0.01,
			};

			const mixedContent = [
				'invalid json',
				JSON.stringify(validData),
				'{ broken json',
				'', // Empty line
			].join('\n');

			await using fixture = await createFixture({
				[CLAUDE_PROJECTS_DIR_NAME]: {
					project1: {
						session1: {
							'chat.jsonl': mixedContent,
						},
					},
				},
			});

			const result = await loadCommonUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			// Should only have 1 valid entry
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.data.message.usage.input_tokens).toBe(100);
		});
	});
}
