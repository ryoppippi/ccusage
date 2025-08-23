/**
 * @fileoverview Data loading utilities for Claude Code usage analysis (REFACTORED)
 *
 * This module now acts as a compatibility layer, re-exporting functions from
 * the newly refactored modules to maintain backward compatibility with external users.
 *
 * @module data-loader
 */

import type {
	DailyUsage,
	LoadOptions,
	SessionUsage,
	UsageData,
} from './_data-schemas.ts';
// Re-export all types and schemas from the new modules
// Import the remaining large functions that haven't been moved yet
import type { LoadedUsageEntry, SessionBlock } from './_session-blocks.ts';
import type {
	ActivityDate,
	ModelName,
	Version,
} from './_types.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toArray } from '@antfu/utils';
import { groupBy, uniq } from 'es-toolkit';
import { createFixture } from 'fs-fixture';
import { CLAUDE_PROJECTS_DIR_NAME, USAGE_DATA_GLOB_PATTERN } from './_consts.ts';
import {
	aggregateByModel,
	calculateTotals,
	createModelBreakdowns,
	extractUniqueModels,
	filterByDateRange,
	filterByProject,
	isDuplicateEntry,
	markAsProcessed,
} from './_data-aggregation.ts';
import { usageDataSchema } from './_data-schemas.ts';
import {
	calculateCostForEntry,
	createUniqueHash,
	extractProjectFromPath,
	formatDate,
	getClaudePaths,
	getUsageLimitResetTime,
	globUsageFiles,
	sortByDate,
	sortFilesByTimestamp,
} from './_data-utils.ts';
import {
	identifySessionBlocks,
} from './_session-blocks.ts';
import {
	createDailyDate,
	createISOTimestamp,
	createProjectPath,
	createSessionId,
} from './_types.ts';
import { logger } from './logger.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

// Re-export aggregation functions (these were internal in the original but might be used)
export type { TokenStats } from './_data-aggregation.ts';

// Re-export loader functions
export {
	calculateContextTokens,
	loadBucketUsageData,
	loadMonthlyUsageData,
	loadSessionUsageById,
	loadWeeklyUsageData,
} from './_data-loaders.ts';

export type {
	BucketUsage,
	DailyUsage,
	DateFilter,
	GlobResult,
	LoadOptions,
	ModelBreakdown,
	MonthlyUsage,
	SessionUsage,
	UsageData,
	WeeklyUsage,
} from './_data-schemas.ts';

export {
	bucketUsageSchema,
	dailyUsageSchema,
	modelBreakdownSchema,
	monthlyUsageSchema,
	sessionUsageSchema,
	transcriptMessageSchema,
	transcriptUsageSchema,
	usageDataSchema,
	weeklyUsageSchema,
} from './_data-schemas.ts';

// Re-export utility functions
export {
	calculateCostForEntry,
	createUniqueHash,
	extractProjectFromPath,
	formatDate,
	formatDateCompact,
	getClaudePaths,
	getEarliestTimestamp,
	getUsageLimitResetTime,
	globUsageFiles,
	sortByDate,
	sortFilesByTimestamp,
} from './_data-utils.ts';

/**
 * Loads and aggregates Claude usage data by day
 * Processes all JSONL files in the Claude projects directory and groups usage by date
 * @param options - Optional configuration for loading and filtering data
 * @returns Array of daily usage summaries sorted by date
 */
export async function loadDailyUsageData(
	options?: LoadOptions,
): Promise<DailyUsage[]> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths in parallel
	const allFiles = await globUsageFiles(claudePaths);
	const fileList = allFiles.map(f => f.file);

	if (fileList.length === 0) {
		return [];
	}

	// Filter by project if specified
	const projectFilteredFiles = filterByProject(
		fileList,
		filePath => extractProjectFromPath(filePath),
		options?.project,
	);

	// Sort files by timestamp to ensure chronological processing
	const sortedFiles = await sortFilesByTimestamp(projectFilteredFiles);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

	// Track processed message+request combinations for deduplication
	const processedHashes = new Set<string>();

	// Collect all valid data entries first
	const allEntries: { data: UsageData; date: string; cost: number; model: string | undefined; project: string }[] = [];

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

				// Check for duplicate message + request ID combination
				const uniqueHash = createUniqueHash(data);
				if (isDuplicateEntry(uniqueHash, processedHashes)) {
					// Skip duplicate message
					continue;
				}

				// Mark this combination as processed
				markAsProcessed(uniqueHash, processedHashes);

				// Always use en-CA for date grouping to ensure YYYY-MM-DD format
				const date = formatDate(data.timestamp, options?.timezone, 'en-CA');
				// If fetcher is available, calculate cost based on mode and tokens
				// If fetcher is null, use pre-calculated costUSD or default to 0
				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				// Extract project name from file path
				const project = extractProjectFromPath(file);

				allEntries.push({ data, date, cost, model: data.message.model, project });
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Group by date, optionally including project
	// Automatically enable project grouping when project filter is specified
	const needsProjectGrouping = options?.groupByProject === true || options?.project != null;
	const groupingKey = needsProjectGrouping
		? (entry: typeof allEntries[0]) => `${entry.date}\x00${entry.project}`
		: (entry: typeof allEntries[0]) => entry.date;

	const groupedData = groupBy(allEntries, groupingKey);

	// Aggregate each group
	const results = Object.entries(groupedData)
		.map(([groupKey, entries]) => {
			if (entries == null) {
				return undefined;
			}

			// Extract date and project from groupKey (format: "date" or "date\x00project")
			const parts = groupKey.split('\x00');
			const date = parts[0] ?? groupKey;
			const project = parts.length > 1 ? parts[1] : undefined;

			// Aggregate by model first
			const modelAggregates = aggregateByModel(
				entries,
				entry => entry.model,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			// Create model breakdowns
			const modelBreakdowns = createModelBreakdowns(modelAggregates);

			// Calculate totals
			const totals = calculateTotals(
				entries,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			const modelsUsed = extractUniqueModels(entries, e => e.model);

			return {
				date: createDailyDate(date),
				...totals,
				modelsUsed: modelsUsed as ModelName[],
				modelBreakdowns,
				...(project != null && { project }),
			};
		})
		.filter(item => item != null);

	// Filter by date range if specified
	const dateFiltered = filterByDateRange(results, item => item.date, options?.since, options?.until);

	// Filter by project if specified
	const finalFiltered = filterByProject(dateFiltered, item => item.project, options?.project);

	// Sort by date based on order option (default to descending)
	return sortByDate(finalFiltered, item => item.date, options?.order);
}

/**
 * Loads and aggregates Claude usage data by session
 * Groups usage data by project path and session ID based on file structure
 * @param options - Optional configuration for loading and filtering data
 * @returns Array of session usage summaries sorted by last activity
 */
export async function loadSessionData(
	options?: LoadOptions,
): Promise<SessionUsage[]> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths with their base directories in parallel
	const filesWithBase = await globUsageFiles(claudePaths);

	if (filesWithBase.length === 0) {
		return [];
	}

	// Filter by project if specified
	const projectFilteredWithBase = filterByProject(
		filesWithBase,
		item => extractProjectFromPath(item.file),
		options?.project,
	);

	// Sort files by timestamp to ensure chronological processing
	// Create a map for O(1) lookup instead of O(N) find operations
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

	// Collect all valid data entries with session info first
	const allEntries: Array<{
		data: UsageData;
		sessionKey: string;
		sessionId: string;
		projectPath: string;
		cost: number;
		timestamp: string;
		model: string | undefined;
	}> = [];

	for (const { file, baseDir } of sortedFilesWithBase) {
		// Extract session info from file path using its specific base directory
		const relativePath = path.relative(baseDir, file);
		const parts = relativePath.split(path.sep);

		// Session ID is the directory name containing the JSONL file
		const sessionId = parts[parts.length - 2] ?? 'unknown';
		// Project path is everything before the session ID
		const joinedPath = parts.slice(0, -2).join(path.sep);
		const projectPath = joinedPath.length > 0 ? joinedPath : 'Unknown Project';

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

				const sessionKey = `${projectPath}/${sessionId}`;
				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({
					data,
					sessionKey,
					sessionId,
					projectPath,
					cost,
					timestamp: data.timestamp,
					model: data.message.model,
				});
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Group by session using Object.groupBy
	const groupedBySessions = groupBy(
		allEntries,
		entry => entry.sessionKey,
	);

	// Aggregate each session group
	const results = Object.entries(groupedBySessions)
		.map(([_, entries]) => {
			if (entries == null) {
				return undefined;
			}

			// Find the latest timestamp for lastActivity
			const latestEntry = entries.reduce((latest, current) =>
				current.timestamp > latest.timestamp ? current : latest,
			);

			// Collect all unique versions
			const versions: string[] = [];
			for (const entry of entries) {
				if (entry.data.version != null) {
					versions.push(entry.data.version);
				}
			}

			// Aggregate by model
			const modelAggregates = aggregateByModel(
				entries,
				entry => entry.model,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			// Create model breakdowns
			const modelBreakdowns = createModelBreakdowns(modelAggregates);

			// Calculate totals
			const totals = calculateTotals(
				entries,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			const modelsUsed = extractUniqueModels(entries, e => e.model);

			return {
				sessionId: createSessionId(latestEntry.sessionId),
				projectPath: createProjectPath(latestEntry.projectPath),
				...totals,
				// Always use en-CA for date storage to ensure YYYY-MM-DD format
				lastActivity: formatDate(latestEntry.timestamp, options?.timezone, 'en-CA') as ActivityDate,
				versions: uniq(versions).sort() as Version[],
				modelsUsed: modelsUsed as ModelName[],
				modelBreakdowns,
			};
		})
		.filter(item => item != null);

	// Filter by date range if specified
	const dateFiltered = filterByDateRange(results, item => item.lastActivity, options?.since, options?.until);

	// Filter by project if specified
	const sessionFiltered = filterByProject(dateFiltered, item => item.projectPath, options?.project);

	return sortByDate(sessionFiltered, item => item.lastActivity, options?.order);
}

/**
 * Loads usage data and organizes it into session blocks (typically 5-hour billing periods)
 * Processes all usage data and groups it into time-based blocks for billing analysis
 * @param options - Optional configuration including session duration and filtering
 * @returns Array of session blocks with usage and cost information
 */
export async function loadSessionBlockData(
	options?: LoadOptions,
): Promise<SessionBlock[]> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths
	const allFiles: string[] = [];
	for (const claudePath of claudePaths) {
		const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
		const files = await import('tinyglobby').then(async ({ glob }) => glob([USAGE_DATA_GLOB_PATTERN], {
			cwd: claudeDir,
			absolute: true,
		}));
		allFiles.push(...files);
	}

	if (allFiles.length === 0) {
		return [];
	}

	// Filter by project if specified
	const blocksFilteredFiles = filterByProject(
		allFiles,
		filePath => extractProjectFromPath(filePath),
		options?.project,
	);

	// Sort files by timestamp to ensure chronological processing
	const sortedFiles = await sortFilesByTimestamp(blocksFilteredFiles);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

	// Track processed message+request combinations for deduplication
	const processedHashes = new Set<string>();

	// Collect all valid data entries first
	const allEntries: LoadedUsageEntry[] = [];

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

				// Get Claude Code usage limit expiration date
				const usageLimitResetTime = getUsageLimitResetTime(data);

				allEntries.push({
					timestamp: new Date(data.timestamp),
					usage: {
						inputTokens: data.message.usage.input_tokens,
						outputTokens: data.message.usage.output_tokens,
						cacheCreationInputTokens: data.message.usage.cache_creation_input_tokens ?? 0,
						cacheReadInputTokens: data.message.usage.cache_read_input_tokens ?? 0,
					},
					costUSD: cost,
					model: data.message.model ?? 'unknown',
					version: data.version,
					usageLimitResetTime: usageLimitResetTime ?? undefined,
				});
			}
			catch (error) {
				// Skip invalid JSON lines but log for debugging purposes
				logger.debug(`Skipping invalid JSON line in 5-hour blocks: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Identify session blocks
	const blocks = identifySessionBlocks(allEntries, options?.sessionDurationHours);

	// Filter by date range if specified
	const dateFiltered = (options?.since != null && options.since !== '') || (options?.until != null && options.until !== '')
		? blocks.filter((block) => {
			// Always use en-CA for date comparison to ensure YYYY-MM-DD format
				const blockDateStr = formatDate(block.startTime.toISOString(), options?.timezone, 'en-CA').replace(/-/g, '');
				if (options.since != null && options.since !== '' && blockDateStr < options.since) {
					return false;
				}
				if (options.until != null && options.until !== '' && blockDateStr > options.until) {
					return false;
				}
				return true;
			})
		: blocks;

	// Sort by start time based on order option
	return sortByDate(dateFiltered, block => block.startTime, options?.order);
}

// Include inline tests from original file
if (import.meta.vitest != null) {
	const { describe, it, expect, vi, afterEach } = import.meta.vitest;

	describe('formatDate', () => {
		it('formats UTC timestamp to local date', () => {
		// Test with UTC timestamps - results depend on local timezone
			expect(formatDate('2024-01-01T00:00:00Z')).toBe('2024-01-01');
			expect(formatDate('2024-12-31T23:59:59Z')).toBe('2024-12-31');
		});

		it('respects timezone parameter', () => {
			// Test date that crosses day boundary
			const testTimestamp = '2024-01-01T15:00:00Z'; // 3 PM UTC = midnight JST next day

			// Default behavior (no timezone) uses system timezone
			expect(formatDate(testTimestamp)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

			// UTC timezone
			expect(formatDate(testTimestamp, 'UTC')).toBe('2024-01-01');

			// Asia/Tokyo timezone (crosses to next day)
			expect(formatDate(testTimestamp, 'Asia/Tokyo')).toBe('2024-01-02');

			// America/New_York timezone
			expect(formatDate('2024-01-02T03:00:00Z', 'America/New_York')).toBe('2024-01-01'); // 3 AM UTC = 10 PM EST previous day

			// Invalid timezone should throw a RangeError
			expect(() => formatDate(testTimestamp, 'Invalid/Timezone')).toThrow(RangeError);
		});

		it('handles various date formats', () => {
			expect(formatDate('2024-01-01')).toBe('2024-01-01');
			expect(formatDate('2024-01-01T12:00:00')).toBe('2024-01-01');
			expect(formatDate('2024-01-01T12:00:00.000Z')).toBe('2024-01-01');
		});

		it('pads single digit months and days', () => {
			// Use UTC noon to avoid timezone issues
			expect(formatDate('2024-01-05T12:00:00Z')).toBe('2024-01-05');
			expect(formatDate('2024-10-01T12:00:00Z')).toBe('2024-10-01');
		});

		it('respects locale parameter', () => {
			const testDate = '2024-08-04T12:00:00Z';

			// Different locales format dates differently
			expect(formatDate(testDate, 'UTC', 'en-US')).toBe('08/04/2024');
			expect(formatDate(testDate, 'UTC', 'en-CA')).toBe('2024-08-04');
			expect(formatDate(testDate, 'UTC', 'ja-JP')).toBe('2024/08/04');
			expect(formatDate(testDate, 'UTC', 'de-DE')).toBe('04.08.2024');
		});
	});

	describe('loadSessionUsageById', async () => {
		const { createFixture } = await import('fs-fixture');
		const { loadSessionUsageById } = await import('./_data-loaders.ts');

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads usage data for a specific session', async () => {
			await using fixture = await createFixture({
				'.claude': {
					projects: {
						'test-project': {
							'session-123.jsonl': `${JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								sessionId: 'session-123',
								message: {
									usage: {
										input_tokens: 100,
										output_tokens: 50,
										cache_creation_input_tokens: 10,
										cache_read_input_tokens: 20,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.5,
							})}\n${JSON.stringify({
								timestamp: '2024-01-01T01:00:00Z',
								sessionId: 'session-123',
								message: {
									usage: {
										input_tokens: 200,
										output_tokens: 100,
										cache_creation_input_tokens: 20,
										cache_read_input_tokens: 40,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 1.0,
							})}`,
						},
					},
				},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.getPath('.claude'));

			const result = await loadSessionUsageById('session-123', { mode: 'display' });

			expect(result).not.toBeNull();
			expect(result?.totalCost).toBe(1.5);
			expect(result?.entries).toHaveLength(2);
		});

		it('returns null for non-existent session', async () => {
			await using fixture = await createFixture({
				'.claude': {
					projects: {
						'test-project': {
							'other-session.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								sessionId: 'other-session',
								message: {
									usage: {
										input_tokens: 100,
										output_tokens: 50,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.5,
							}),
						},
					},
				},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.getPath('.claude'));

			const result = await loadSessionUsageById('non-existent', { mode: 'display' });

			expect(result).toBeNull();
		});
	});

	describe('loadDailyUsageData', () => {
		it('returns empty array when no files found', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('aggregates daily usage data correctly', async () => {
			// Use timestamps in the middle of the day to avoid timezone issues
			const mockData1: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			];

			const mockData2: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T18:00:00Z'),
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			};

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file1.jsonl': mockData1.map(d => JSON.stringify(d)).join('\n'),
						},
						session2: {
							'file2.jsonl': JSON.stringify(mockData2),
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.date).toBe('2024-01-01');
			expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
			expect(result[0]?.outputTokens).toBe(300); // 50 + 100 + 150
			expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
		});
	});
}
