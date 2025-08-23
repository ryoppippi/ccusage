/**
 * @fileoverview Data loading utilities for Claude Code usage analysis
 *
 * This module provides functions for loading and parsing Claude Code usage data
 * from JSONL files stored in Claude data directories. It handles data aggregation
 * for daily, monthly, and session-based reporting.
 *
 * @module data-loader
 */

import type { WeekDay } from './_consts.ts';
import type { LoadedUsageEntry, SessionBlock } from './_session-blocks.ts';
import type {
	ActivityDate,
	Bucket,
	CostMode,
	ModelName,
	SortOrder,
	Version,
} from './_types.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { toArray } from '@antfu/utils';
import { Result } from '@praha/byethrow';
import { groupBy, uniq } from 'es-toolkit'; // TODO: after node20 is deprecated, switch to native Object.groupBy
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import { z } from 'zod';
import { CLAUDE_CONFIG_DIR_ENV, CLAUDE_PROJECTS_DIR_NAME, DEFAULT_CLAUDE_CODE_PATH, DEFAULT_CLAUDE_CONFIG_PATH, DEFAULT_LOCALE, USAGE_DATA_GLOB_PATTERN, USER_HOME_DIR } from './_consts.ts';
import {
	filterByDateRange,
	formatDate,
	formatDateCompact,
	getDateWeek,
	getDayNumber,
	sortByDate,
} from './_date-utils.ts';
import {
	identifySessionBlocks,
} from './_session-blocks.ts';
import {
	activityDateSchema,
	createBucket,
	createDailyDate,
	createISOTimestamp,
	createMessageId,
	createModelName,
	createMonthlyDate,
	createProjectPath,
	createRequestId,
	createSessionId,
	createVersion,
	createWeeklyDate,
	dailyDateSchema,
	isoTimestampSchema,
	messageIdSchema,
	modelNameSchema,
	monthlyDateSchema,
	projectPathSchema,
	requestIdSchema,
	sessionIdSchema,
	versionSchema,
	weeklyDateSchema,
} from './_types.ts';
import { unreachable } from './_utils.ts';
import { logger } from './logger.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

/**
 * Get Claude data directories to search for usage data
 * When CLAUDE_CONFIG_DIR is set: uses only those paths
 * When not set: uses default paths (~/.config/claude and ~/.claude)
 * @returns Array of valid Claude data directory paths
 */
export function getClaudePaths(): string[] {
	const paths = [];
	const normalizedPaths = new Set<string>();

	// Check environment variable first (supports comma-separated paths)
	const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
	if (envPaths !== '') {
		const envPathList = envPaths.split(',').map(p => p.trim()).filter(p => p !== '');
		for (const envPath of envPathList) {
			const normalizedPath = path.resolve(envPath);
			if (isDirectorySync(normalizedPath)) {
				const projectsPath = path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME);
				if (isDirectorySync(projectsPath)) {
					// Avoid duplicates using normalized paths
					if (!normalizedPaths.has(normalizedPath)) {
						normalizedPaths.add(normalizedPath);
						paths.push(normalizedPath);
					}
				}
			}
		}
		// If environment variable is set, return only those paths (or error if none valid)
		if (paths.length > 0) {
			return paths;
		}
		// If environment variable is set but no valid paths found, throw error
		throw new Error(
			`No valid Claude data directories found in CLAUDE_CONFIG_DIR. Please ensure the following exists:
- ${envPaths}/${CLAUDE_PROJECTS_DIR_NAME}`.trim(),
		);
	}

	// Only check default paths if no environment variable is set
	const defaultPaths = [
		DEFAULT_CLAUDE_CONFIG_PATH, // New default: XDG config directory
		path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH), // Old default: ~/.claude
	];

	for (const defaultPath of defaultPaths) {
		const normalizedPath = path.resolve(defaultPath);
		if (isDirectorySync(normalizedPath)) {
			const projectsPath = path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME);
			if (isDirectorySync(projectsPath)) {
				// Avoid duplicates using normalized paths
				if (!normalizedPaths.has(normalizedPath)) {
					normalizedPaths.add(normalizedPath);
					paths.push(normalizedPath);
				}
			}
		}
	}

	if (paths.length === 0) {
		throw new Error(
			`No valid Claude data directories found. Please ensure at least one of the following exists:
- ${path.join(DEFAULT_CLAUDE_CONFIG_PATH, CLAUDE_PROJECTS_DIR_NAME)}
- ${path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH, CLAUDE_PROJECTS_DIR_NAME)}
- Or set ${CLAUDE_CONFIG_DIR_ENV} environment variable to valid directory path(s) containing a '${CLAUDE_PROJECTS_DIR_NAME}' subdirectory`.trim(),
		);
	}

	return paths;
}

/**
 * Extract project name from Claude JSONL file path
 * @param jsonlPath - Absolute path to JSONL file
 * @returns Project name extracted from path, or "unknown" if malformed
 */
export function extractProjectFromPath(jsonlPath: string): string {
	// Normalize path separators for cross-platform compatibility
	const normalizedPath = jsonlPath.replace(/[/\\]/g, path.sep);
	const segments = normalizedPath.split(path.sep);
	const projectsIndex = segments.findIndex(segment => segment === CLAUDE_PROJECTS_DIR_NAME);

	if (projectsIndex === -1 || projectsIndex + 1 >= segments.length) {
		return 'unknown';
	}

	const projectName = segments[projectsIndex + 1];
	return projectName != null && projectName.trim() !== '' ? projectName : 'unknown';
}

/**
 * Zod schema for validating Claude usage data from JSONL files
 */
export const usageDataSchema = z.object({
	cwd: z.string().optional(), // Claude Code version, optional for compatibility
	sessionId: sessionIdSchema.optional(), // Session ID for deduplication
	timestamp: isoTimestampSchema,
	version: versionSchema.optional(), // Claude Code version
	message: z.object({
		usage: z.object({
			input_tokens: z.number(),
			output_tokens: z.number(),
			cache_creation_input_tokens: z.number().optional(),
			cache_read_input_tokens: z.number().optional(),
		}),
		model: modelNameSchema.optional(), // Model is inside message object
		id: messageIdSchema.optional(), // Message ID for deduplication
		content: z.array(z.object({
			text: z.string().optional(),
		})).optional(),
	}),
	costUSD: z.number().optional(), // Made optional for new schema
	requestId: requestIdSchema.optional(), // Request ID for deduplication
	isApiErrorMessage: z.boolean().optional(),
});

/**
 * Zod schema for transcript usage data from Claude messages
 */
export const transcriptUsageSchema = z.object({
	input_tokens: z.number().optional(),
	cache_creation_input_tokens: z.number().optional(),
	cache_read_input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
});

/**
 * Zod schema for transcript message data
 */
export const transcriptMessageSchema = z.object({
	type: z.string().optional(),
	message: z.object({
		usage: transcriptUsageSchema.optional(),
	}).optional(),
});

/**
 * Type definition for Claude usage data entries from JSONL files
 */
export type UsageData = z.infer<typeof usageDataSchema>;

/**
 * Zod schema for model-specific usage breakdown data
 */
export const modelBreakdownSchema = z.object({
	modelName: modelNameSchema,
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	cost: z.number(),
});

/**
 * Type definition for model-specific usage breakdown
 */
export type ModelBreakdown = z.infer<typeof modelBreakdownSchema>;

/**
 * Zod schema for daily usage aggregation data
 */
export const dailyUsageSchema = z.object({
	date: dailyDateSchema, // YYYY-MM-DD format
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for daily usage aggregation
 */
export type DailyUsage = z.infer<typeof dailyUsageSchema>;

/**
 * Zod schema for session-based usage aggregation data
 */
export const sessionUsageSchema = z.object({
	sessionId: sessionIdSchema,
	projectPath: projectPathSchema,
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	lastActivity: activityDateSchema,
	versions: z.array(versionSchema), // List of unique versions used in this session
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

/**
 * Type definition for session-based usage aggregation
 */
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/**
 * Zod schema for monthly usage aggregation data
 */
export const monthlyUsageSchema = z.object({
	month: monthlyDateSchema, // YYYY-MM format
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for monthly usage aggregation
 */
export type MonthlyUsage = z.infer<typeof monthlyUsageSchema>;

/**
 * Zod schema for weekly usage aggregation data
 */
export const weeklyUsageSchema = z.object({
	week: weeklyDateSchema, // YYYY-MM-DD format
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for weekly usage aggregation
 */
export type WeeklyUsage = z.infer<typeof weeklyUsageSchema>;

/**
 * Zod schema for bucket usage aggregation data
 */
export const bucketUsageSchema = z.object({
	bucket: z.union([weeklyDateSchema, monthlyDateSchema]), // WeeklyDate or MonthlyDate
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for bucket usage aggregation
 */
export type BucketUsage = z.infer<typeof bucketUsageSchema>;

/**
 * Internal type for aggregating token statistics and costs
 */
type TokenStats = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

/**
 * Aggregates token counts and costs by model name
 */
function aggregateByModel<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): Map<string, TokenStats> {
	const modelAggregates = new Map<string, TokenStats>();
	const defaultStats: TokenStats = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		cost: 0,
	};

	for (const entry of entries) {
		const modelName = getModel(entry) ?? 'unknown';
		// Skip synthetic model
		if (modelName === '<synthetic>') {
			continue;
		}

		const usage = getUsage(entry);
		const cost = getCost(entry);

		const existing = modelAggregates.get(modelName) ?? defaultStats;

		modelAggregates.set(modelName, {
			inputTokens: existing.inputTokens + (usage.input_tokens ?? 0),
			outputTokens: existing.outputTokens + (usage.output_tokens ?? 0),
			cacheCreationTokens: existing.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
			cacheReadTokens: existing.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
			cost: existing.cost + cost,
		});
	}

	return modelAggregates;
}

/**
 * Aggregates model breakdowns from multiple sources
 */
function aggregateModelBreakdowns(
	breakdowns: ModelBreakdown[],
): Map<string, TokenStats> {
	const modelAggregates = new Map<string, TokenStats>();
	const defaultStats: TokenStats = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		cost: 0,
	};

	for (const breakdown of breakdowns) {
		// Skip synthetic model
		if (breakdown.modelName === '<synthetic>') {
			continue;
		}

		const existing = modelAggregates.get(breakdown.modelName) ?? defaultStats;

		modelAggregates.set(breakdown.modelName, {
			inputTokens: existing.inputTokens + breakdown.inputTokens,
			outputTokens: existing.outputTokens + breakdown.outputTokens,
			cacheCreationTokens: existing.cacheCreationTokens + breakdown.cacheCreationTokens,
			cacheReadTokens: existing.cacheReadTokens + breakdown.cacheReadTokens,
			cost: existing.cost + breakdown.cost,
		});
	}

	return modelAggregates;
}

/**
 * Converts model aggregates to sorted model breakdowns
 */
function createModelBreakdowns(
	modelAggregates: Map<string, TokenStats>,
): ModelBreakdown[] {
	return Array.from(modelAggregates.entries())
		.map(([modelName, stats]) => ({
			modelName: modelName as ModelName,
			...stats,
		}))
		.sort((a, b) => b.cost - a.cost); // Sort by cost descending
}

/**
 * Calculates total token counts and costs from entries
 */
function calculateTotals<T>(
	entries: T[],
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): TokenStats & { totalCost: number } {
	return entries.reduce(
		(acc, entry) => {
			const usage = getUsage(entry);
			const cost = getCost(entry);

			return {
				inputTokens: acc.inputTokens + (usage.input_tokens ?? 0),
				outputTokens: acc.outputTokens + (usage.output_tokens ?? 0),
				cacheCreationTokens: acc.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
				cacheReadTokens: acc.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
				cost: acc.cost + cost,
				totalCost: acc.totalCost + cost,
			};
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
			totalCost: 0,
		},
	);
}

/**
 * Filters items by project name
 */
function filterByProject<T>(
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

/**
 * Extracts unique models from entries, excluding synthetic model
 */
function extractUniqueModels<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
): string[] {
	return uniq(entries.map(getModel).filter((m): m is string => m != null && m !== '<synthetic>'));
}

/**
 * Create a unique identifier for deduplication using message ID and request ID
 */
export function createUniqueHash(data: UsageData): string | null {
	const messageId = data.message.id;
	const requestId = data.requestId;

	if (messageId == null || requestId == null) {
		return null;
	}

	// Create a hash using simple concatenation
	return `${messageId}:${requestId}`;
}

/**
 * Extract the earliest timestamp from a JSONL file
 * Scans through the file until it finds a valid timestamp
 */
export async function getEarliestTimestamp(filePath: string): Promise<Date | null> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const lines = content.trim().split('\n');

		let earliestDate: Date | null = null;

		for (const line of lines) {
			if (line.trim() === '') {
				continue;
			}

			try {
				const json = JSON.parse(line) as Record<string, unknown>;
				if (json.timestamp != null && typeof json.timestamp === 'string') {
					const date = new Date(json.timestamp);
					if (!Number.isNaN(date.getTime())) {
						if (earliestDate == null || date < earliestDate) {
							earliestDate = date;
						}
					}
				}
			}
			catch {
				// Skip invalid JSON lines
				continue;
			}
		}

		return earliestDate;
	}
	catch (error) {
		// Log file access errors for diagnostics, but continue processing
		// This ensures files without timestamps or with access issues are sorted to the end
		logger.debug(`Failed to get earliest timestamp for ${filePath}:`, error);
		return null;
	}
}

/**
 * Sort files by their earliest timestamp
 * Files without valid timestamps are placed at the end
 */
export async function sortFilesByTimestamp(files: string[]): Promise<string[]> {
	const filesWithTimestamps = await Promise.all(
		files.map(async file => ({
			file,
			timestamp: await getEarliestTimestamp(file),
		})),
	);

	return filesWithTimestamps
		.sort((a, b) => {
			// Files without timestamps go to the end
			if (a.timestamp == null && b.timestamp == null) {
				return 0;
			}
			if (a.timestamp == null) {
				return 1;
			}
			if (b.timestamp == null) {
				return -1;
			}
			// Sort by timestamp (oldest first)
			return a.timestamp.getTime() - b.timestamp.getTime();
		})
		.map(item => item.file);
}

/**
 * Calculates cost for a single usage data entry based on the specified cost calculation mode
 * @param data - Usage data entry
 * @param mode - Cost calculation mode (auto, calculate, or display)
 * @param fetcher - Pricing fetcher instance for calculating costs from tokens
 * @returns Calculated cost in USD
 */
export async function calculateCostForEntry(
	data: UsageData,
	mode: CostMode,
	fetcher: PricingFetcher,
): Promise<number> {
	if (mode === 'display') {
		// Always use costUSD, even if undefined
		return data.costUSD ?? 0;
	}

	if (mode === 'calculate') {
		// Always calculate from tokens
		if (data.message.model != null) {
			return Result.unwrap(fetcher.calculateCostFromTokens(data.message.usage, data.message.model), 0);
		}
		return 0;
	}

	if (mode === 'auto') {
		// Auto mode: use costUSD if available, otherwise calculate
		if (data.costUSD != null) {
			return data.costUSD;
		}

		if (data.message.model != null) {
			return Result.unwrap(fetcher.calculateCostFromTokens(data.message.usage, data.message.model), 0);
		}

		return 0;
	}

	unreachable(mode);
}

/**
 * Get Claude Code usage limit expiration date
 * @param data - Usage data entry
 * @returns Usage limit expiration date
 */
export function getUsageLimitResetTime(data: UsageData): Date | null {
	let resetTime: Date | null = null;

	if (data.isApiErrorMessage === true) {
		const timestampMatch = data.message?.content?.find(
			c => c.text != null && c.text.includes('Claude AI usage limit reached'),
		)?.text?.match(/\|(\d+)/) ?? null;

		if (timestampMatch?.[1] != null) {
			const resetTimestamp = Number.parseInt(timestampMatch[1]);
			resetTime = resetTimestamp > 0 ? new Date(resetTimestamp * 1000) : null;
		}
	}

	return resetTime;
}

/**
 * Result of glob operation with base directory information
 */
export type GlobResult = {
	file: string;
	baseDir: string;
};

/**
 * Glob files from multiple Claude paths in parallel
 * @param claudePaths - Array of Claude base paths
 * @returns Array of file paths with their base directories
 */
export async function globUsageFiles(claudePaths: string[]): Promise<GlobResult[]> {
	const filePromises = claudePaths.map(async (claudePath) => {
		const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
		const files = await glob([USAGE_DATA_GLOB_PATTERN], {
			cwd: claudeDir,
			absolute: true,
		}).catch(() => []); // Gracefully handle errors for individual paths

		// Map each file to include its base directory
		return files.map(file => ({ file, baseDir: claudeDir }));
	});
	return (await Promise.all(filePromises)).flat();
}

/**
 * Date range filter for limiting usage data by date
 */
export type DateFilter = {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
};

/**
 * Configuration options for loading usage data
 */
export type LoadOptions = {
	claudePath?: string; // Custom path to Claude data directory
	mode?: CostMode; // Cost calculation mode
	order?: SortOrder; // Sort order for dates
	offline?: boolean; // Use offline mode for pricing
	sessionDurationHours?: number; // Session block duration in hours
	groupByProject?: boolean; // Group data by project instead of aggregating
	project?: string; // Filter to specific project name
	startOfWeek?: WeekDay; // Start of week for weekly aggregation
	timezone?: string; // Timezone for date grouping (e.g., 'UTC', 'America/New_York'). Defaults to system timezone
	locale?: string; // Locale for date/time formatting (e.g., 'en-US', 'ja-JP'). Defaults to 'en-US'
} & DateFilter;

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

				// Always use DEFAULT_LOCALE for date grouping to ensure YYYY-MM-DD format
				const date = formatDate(data.timestamp, options?.timezone, DEFAULT_LOCALE);
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
				// Always use DEFAULT_LOCALE for date storage to ensure YYYY-MM-DD format
				lastActivity: formatDate(latestEntry.timestamp, options?.timezone, DEFAULT_LOCALE) as ActivityDate,
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
 * Loads and aggregates Claude usage data by month
 * Uses daily usage data as the source and groups by month
 * @param options - Optional configuration for loading and filtering data
 * @returns Array of monthly usage summaries sorted by month
 */
export async function loadMonthlyUsageData(
	options?: LoadOptions,
): Promise<MonthlyUsage[]> {
	return loadBucketUsageData((data: DailyUsage) => createMonthlyDate(data.date.substring(0, 7)), options)
		.then(usages => usages.map<MonthlyUsage>(({ bucket, ...rest }) => ({
			month: createMonthlyDate(bucket.toString()),
			...rest,
		})));
}

export async function loadWeeklyUsageData(
	options?: LoadOptions,
): Promise<WeeklyUsage[]> {
	const startDay = options?.startOfWeek != null ? getDayNumber(options.startOfWeek) : getDayNumber('sunday');

	return loadBucketUsageData((data: DailyUsage) => getDateWeek(new Date(data.date), startDay), options)
		.then(usages => usages.map<WeeklyUsage>(({ bucket, ...rest }) => ({
			week: createWeeklyDate(bucket.toString()),
			...rest,
		})));
}

/**
 * Load usage data for a specific session by sessionId
 * Searches for a JSONL file named {sessionId}.jsonl in all Claude project directories
 * @param sessionId - The session ID to load data for (matches the JSONL filename)
 * @param options - Options for loading data
 * @param options.mode - Cost calculation mode (auto, calculate, display)
 * @param options.offline - Whether to use offline pricing data
 * @returns Usage data for the specific session or null if not found
 */
export async function loadSessionUsageById(
	sessionId: string,
	options?: { mode?: CostMode; offline?: boolean },
): Promise<{ totalCost: number; entries: UsageData[] } | null> {
	const claudePaths = getClaudePaths();

	// Find the JSONL file for this session ID
	// On Windows, replace backslashes from path.join with forward slashes for tinyglobby compatibility
	const patterns = claudePaths.map(p => path.join(p, 'projects', '**', `${sessionId}.jsonl`).replace(/\\/g, '/'));
	const jsonlFiles = await glob(patterns);

	if (jsonlFiles.length === 0) {
		return null;
	}

	const file = jsonlFiles[0];
	if (file == null) {
		return null;
	}
	const content = await readFile(file, 'utf-8');
	const lines = content.trim().split('\n').filter(line => line.length > 0);

	const mode = options?.mode ?? 'auto';
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

	const entries: UsageData[] = [];
	let totalCost = 0;

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as unknown;
			const result = usageDataSchema.safeParse(parsed);
			if (!result.success) {
				continue;
			}
			const data = result.data;

			const cost = fetcher != null
				? await calculateCostForEntry(data, mode, fetcher)
				: data.costUSD ?? 0;

			totalCost += cost;
			entries.push(data);
		}
		catch {
			// Skip invalid JSON lines
		}
	}

	return { totalCost, entries };
}

export async function loadBucketUsageData(
	groupingFn: (data: DailyUsage) => Bucket,
	options?: LoadOptions,
): Promise<BucketUsage[]> {
	const dailyData = await loadDailyUsageData(options);

	// Group daily data by week, optionally including project
	// Automatically enable project grouping when project filter is specified
	const needsProjectGrouping
    = options?.groupByProject === true || options?.project != null;

	const groupingKey = needsProjectGrouping
		? (data: DailyUsage) =>
				`${groupingFn(data)}\x00${data.project ?? 'unknown'}`
		: (data: DailyUsage) => `${groupingFn(data)}`;

	const grouped = groupBy(dailyData, groupingKey);

	const buckets: BucketUsage[] = [];
	for (const [groupKey, dailyEntries] of Object.entries(grouped)) {
		if (dailyEntries == null) {
			continue;
		}

		const parts = groupKey.split('\x00');
		const bucket = createBucket(parts[0] ?? groupKey);
		const project = parts.length > 1 ? parts[1] : undefined;

		// Aggregate model breakdowns across all days
		const allBreakdowns = dailyEntries.flatMap(
			daily => daily.modelBreakdowns,
		);
		const modelAggregates = aggregateModelBreakdowns(allBreakdowns);

		// Create model breakdowns
		const modelBreakdowns = createModelBreakdowns(modelAggregates);

		// Collect unique models
		const models: string[] = [];
		for (const data of dailyEntries) {
			for (const model of data.modelsUsed) {
				// Skip synthetic model
				if (model !== '<synthetic>') {
					models.push(model);
				}
			}
		}

		// Calculate totals from daily entries
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheCreationTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCost = 0;

		for (const daily of dailyEntries) {
			totalInputTokens += daily.inputTokens;
			totalOutputTokens += daily.outputTokens;
			totalCacheCreationTokens += daily.cacheCreationTokens;
			totalCacheReadTokens += daily.cacheReadTokens;
			totalCost += daily.totalCost;
		}
		const bucketUsage: BucketUsage = {
			bucket,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			cacheReadTokens: totalCacheReadTokens,
			totalCost,
			modelsUsed: uniq(models) as ModelName[],
			modelBreakdowns,
			...(project != null && { project }),
		};

		buckets.push(bucketUsage);
	}

	return sortByDate(buckets, item => item.bucket, options?.order);
}

/**
 * Calculate context tokens from transcript file using improved JSONL parsing
 * Based on the Python reference implementation for better accuracy
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns Object with context tokens info or null if unavailable
 */
export async function calculateContextTokens(transcriptPath: string, modelId?: string, offline = false): Promise<{
	inputTokens: number;
	percentage: number;
	contextLimit: number;
} | null> {
	let content: string;
	try {
		content = await readFile(transcriptPath, 'utf-8');
	}
	catch (error: unknown) {
		logger.debug(`Failed to read transcript file: ${String(error)}`);
		return null;
	}

	const lines = content.split('\n').reverse(); // Iterate from last line to first line

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine === '') {
			continue;
		}

		try {
			const parsed = JSON.parse(trimmedLine) as unknown;
			const result = transcriptMessageSchema.safeParse(parsed);
			if (!result.success) {
				continue; // Skip malformed JSON lines
			}
			const obj = result.data;

			// Check if this line contains the required token usage fields
			if (obj.type === 'assistant'
				&& obj.message != null
				&& obj.message.usage != null
				&& obj.message.usage.input_tokens != null) {
				const usage = obj.message.usage;
				const inputTokens
					= usage.input_tokens!
						+ (usage.cache_creation_input_tokens ?? 0)
						+ (usage.cache_read_input_tokens ?? 0);

				// Get context limit from PricingFetcher
				let contextLimit = 200_000; // Fallback for when modelId is not provided
				if (modelId != null && modelId !== '') {
					using fetcher = new PricingFetcher(offline);
					const contextLimitResult = await fetcher.getModelContextLimit(modelId);
					if (Result.isSuccess(contextLimitResult) && contextLimitResult.value != null) {
						contextLimit = contextLimitResult.value;
					}
					else if (Result.isSuccess(contextLimitResult)) {
						// Context limit not available for this model in LiteLLM
						logger.debug(`No context limit data available for model ${modelId} in LiteLLM`);
					}
					else {
						// Error occurred
						logger.debug(`Failed to get context limit for model ${modelId}: ${contextLimitResult.error.message}`);
					}
				}

				const percentage = Math.min(100, Math.max(0, Math.round((inputTokens / contextLimit) * 100)));

				return {
					inputTokens,
					percentage,
					contextLimit,
				};
			}
		}
		catch {
			continue; // Skip malformed JSON lines
		}
	}

	// No valid usage information found
	logger.debug('No usage information found in transcript');
	return null;
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
		const files = await glob([USAGE_DATA_GLOB_PATTERN], {
			cwd: claudeDir,
			absolute: true,
		});
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
				// Always use DEFAULT_LOCALE for date comparison to ensure YYYY-MM-DD format
				const blockDateStr = formatDate(block.startTime.toISOString(), options?.timezone, DEFAULT_LOCALE).replace(/-/g, '');
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

if (import.meta.vitest != null) {
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

		it('formatDateCompact respects timezone parameter', () => {
			const testTimestamp = '2024-01-01T15:00:00Z';

			// UTC timezone
			expect(formatDateCompact(testTimestamp, 'UTC', 'en-US')).toBe('2024\n01-01');

			// Asia/Tokyo timezone (crosses to next day)
			expect(formatDateCompact(testTimestamp, 'Asia/Tokyo', 'en-US')).toBe('2024\n01-02');

			// Daily date defined as UTC is preserved
			expect(formatDateCompact('2024-01-01', 'UTC', 'en-US')).toBe('2024\n01-01');

			// Daily date already in local time is preserved instead of being interpreted as UTC
			expect(formatDateCompact('2024-01-01', undefined, 'en-US')).toBe('2024\n01-01');
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

	describe('formatDateCompact', () => {
		it('formats UTC timestamp to local date with line break', () => {
			expect(formatDateCompact('2024-01-01T00:00:00Z', undefined, 'en-US')).toBe('2024\n01-01');
		});

		it('handles various date formats', () => {
			expect(formatDateCompact('2024-12-31T23:59:59Z', undefined, 'en-US')).toBe('2024\n12-31');
			expect(formatDateCompact('2024-01-01', undefined, 'en-US')).toBe('2024\n01-01');
			expect(formatDateCompact('2024-01-01T12:00:00', undefined, 'en-US')).toBe('2024\n01-01');
			expect(formatDateCompact('2024-01-01T12:00:00.000Z', undefined, 'en-US')).toBe('2024\n01-01');
		});

		it('pads single digit months and days', () => {
			// Use UTC noon to avoid timezone issues
			expect(formatDateCompact('2024-01-05T12:00:00Z', undefined, 'en-US')).toBe('2024\n01-05');
			expect(formatDateCompact('2024-10-01T12:00:00Z', undefined, 'en-US')).toBe('2024\n10-01');
		});

		it('respects locale parameter', () => {
			const testDate = '2024-08-04T12:00:00Z';

			// Different locales format dates differently
			expect(formatDateCompact(testDate, 'UTC', 'en-US')).toBe('2024\n08-04');
			expect(formatDateCompact(testDate, 'UTC', 'en-CA')).toBe('2024\n08-04');
			expect(formatDateCompact(testDate, 'UTC', 'ja-JP')).toBe('2024\n08-04');
			// All locales should produce similar compact format
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

		it('handles cache tokens', async () => {
			const mockData: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 25,
						cache_read_input_tokens: 10,
					},
				},
				costUSD: 0.01,
			};

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': JSON.stringify(mockData),
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result[0]?.cacheCreationTokens).toBe(25);
			expect(result[0]?.cacheReadTokens).toBe(10);
		});

		it('filters by date range', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240125',
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.date).toBe('2024-01-15');
			expect(result[0]?.inputTokens).toBe(200);
		});

		it('sorts by date descending by default', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result[0]?.date).toBe('2024-01-31');
			expect(result[1]?.date).toBe('2024-01-15');
			expect(result[2]?.date).toBe('2024-01-01');
		});

		it('sorts by date ascending when order is \'asc\'', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'usage.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});

			expect(result).toHaveLength(3);
			expect(result[0]?.date).toBe('2024-01-01');
			expect(result[1]?.date).toBe('2024-01-15');
			expect(result[2]?.date).toBe('2024-01-31');
		});

		it('sorts by date descending when order is \'desc\'', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'usage.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				order: 'desc',
			});

			expect(result).toHaveLength(3);
			expect(result[0]?.date).toBe('2024-01-31');
			expect(result[1]?.date).toBe('2024-01-15');
			expect(result[2]?.date).toBe('2024-01-01');
		});

		it('handles invalid JSON lines gracefully', async () => {
			const mockData = `
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
invalid json line
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":200,"output_tokens":100}},"costUSD":0.02}
{ broken json
{"timestamp":"2024-01-01T18:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData,
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			// Should only process valid lines
			expect(result).toHaveLength(1);
			expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
			expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
		});

		it('skips data without required fields', async () => {
			const mockData = `
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
{"timestamp":"2024-01-01T14:00:00Z","message":{"usage":{}}}
{"timestamp":"2024-01-01T18:00:00Z","message":{}}
{"timestamp":"2024-01-01T20:00:00Z"}
{"message":{"usage":{"input_tokens":200,"output_tokens":100}}}
{"timestamp":"2024-01-01T22:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData,
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			// Should only include valid entries
			expect(result).toHaveLength(1);
			expect(result[0]?.inputTokens).toBe(400); // 100 + 300
			expect(result[0]?.totalCost).toBe(0.04); // 0.01 + 0.03
		});
	});

	describe('loadMonthlyUsageData', () => {
		it('aggregates daily data by month correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });

			// Should be sorted by month descending (2024-02 first)
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				month: '2024-02',
				inputTokens: 150,
				outputTokens: 75,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.015,
				modelsUsed: [],
				modelBreakdowns: [{
					modelName: 'unknown',
					inputTokens: 150,
					outputTokens: 75,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.015,
				}],
			});
			expect(result[1]).toEqual({
				month: '2024-01',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [{
					modelName: 'unknown',
					inputTokens: 300,
					outputTokens: 150,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.03,
				}],
			});
		});

		it('handles empty data', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('handles single month data', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				month: '2024-01',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [{
					modelName: 'unknown',
					inputTokens: 300,
					outputTokens: 150,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.03,
				}],
			});
		});

		it('sorts months in descending order', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-03-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });
			const months = result.map(r => r.month);

			expect(months).toEqual(['2024-03', '2024-02', '2024-01', '2023-12']);
		});

		it('sorts months in ascending order when order is \'asc\'', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-03-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});
			const months = result.map(r => r.month);

			expect(months).toEqual(['2023-12', '2024-01', '2024-02', '2024-03']);
		});

		it('handles year boundaries correctly in sorting', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-11-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			// Descending order (default)
			const descResult = await loadMonthlyUsageData({
				claudePath: fixture.path,
				order: 'desc',
			});
			const descMonths = descResult.map(r => r.month);
			expect(descMonths).toEqual(['2024-02', '2024-01', '2023-12', '2023-11']);

			// Ascending order
			const ascResult = await loadMonthlyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});
			const ascMonths = ascResult.map(r => r.month);
			expect(ascMonths).toEqual(['2023-11', '2023-12', '2024-01', '2024-02']);
		});

		it('respects date filters', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-03-01T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240225',
			});

			// Should only include February data
			expect(result).toHaveLength(1);
			expect(result[0]?.month).toBe('2024-02');
			expect(result[0]?.inputTokens).toBe(200);
		});

		it('handles cache tokens correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 25,
							cache_read_input_tokens: 10,
						},
					},
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 50,
							cache_read_input_tokens: 20,
						},
					},
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.cacheCreationTokens).toBe(75); // 25 + 50
			expect(result[0]?.cacheReadTokens).toBe(30); // 10 + 20
		});
	});

	describe('loadWeeklyUsageData', () => {
		it('aggregates daily data by week correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-02T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });

			// Should be sorted by week descending (2024-01-15 first)
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				week: '2024-01-14',
				inputTokens: 150,
				outputTokens: 75,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.015,
				modelsUsed: [],
				modelBreakdowns: [{
					modelName: 'unknown',
					inputTokens: 150,
					outputTokens: 75,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.015,
				}],
			});
			expect(result[1]).toEqual({
				week: '2023-12-31',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [{
					modelName: 'unknown',
					inputTokens: 300,
					outputTokens: 150,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.03,
				}],
			});
		});

		it('handles empty data', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('handles single week data', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-03T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				week: '2023-12-31',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [{
					modelName: 'unknown',
					inputTokens: 300,
					outputTokens: 150,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.03,
				}],
			});
		});

		it('sorts weeks in descending order', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-08T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-22T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });
			const weeks = result.map(r => r.week);

			expect(weeks).toEqual(['2024-01-21', '2024-01-14', '2024-01-07', '2023-12-31']);
		});

		it('sorts weeks in ascending order when order is \'asc\'', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-08T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-22T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path, order: 'asc' });
			const weeks = result.map(r => r.week);

			expect(weeks).toEqual(['2023-12-31', '2024-01-07', '2024-01-14', '2024-01-21']);
		});

		it('handles year boundaries correctly in sorting', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-04T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-05T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-11-06T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			// Descending order (default)
			const descResult = await loadWeeklyUsageData({
				claudePath: fixture.path,
				order: 'desc',
			});
			const descWeeks = descResult.map(r => r.week);
			expect(descWeeks).toEqual(['2024-02-04', '2023-12-31', '2023-12-03', '2023-11-05']);

			// Ascending order
			const ascResult = await loadWeeklyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});
			const ascWeeks = ascResult.map(r => r.week);
			expect(ascWeeks).toEqual(['2023-11-05', '2023-12-03', '2023-12-31', '2024-02-04']);
		});

		it('respects date filters', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-02T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-06T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-03-05T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240225',
			});

			// Should only include February data
			expect(result).toHaveLength(1);
			expect(result[0]?.week).toBe('2024-02-04');
			expect(result[0]?.inputTokens).toBe(200);
		});

		it('handles cache tokens correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-02T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 25,
							cache_read_input_tokens: 10,
						},
					},
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-03T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 50,
							cache_read_input_tokens: 20,
						},
					},
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.cacheCreationTokens).toBe(75); // 25 + 50
			expect(result[0]?.cacheReadTokens).toBe(30); // 10 + 20
		});
	});

	describe('loadSessionData', () => {
		it('returns empty array when no files found', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadSessionData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('extracts session info from file paths', async () => {
			const mockData: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			};

			await using fixture = await createFixture({
				projects: {
					'project1/subfolder': {
						session123: {
							'chat.jsonl': JSON.stringify(mockData),
						},
					},
					'project2': {
						session456: {
							'chat.jsonl': JSON.stringify(mockData),
						},
					},
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			expect(result).toHaveLength(2);
			expect(result.find(s => s.sessionId === 'session123')).toBeTruthy();
			expect(
				result.find(s => s.projectPath === 'project1/subfolder'),
			).toBeTruthy();
			expect(result.find(s => s.sessionId === 'session456')).toBeTruthy();
			expect(result.find(s => s.projectPath === 'project2')).toBeTruthy();
		});

		it('aggregates session usage data', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 10,
							cache_read_input_tokens: 5,
						},
					},
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 20,
							cache_read_input_tokens: 10,
						},
					},
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'chat.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			const session = result[0];
			expect(session?.sessionId).toBe('session1');
			expect(session?.projectPath).toBe('project1');
			expect(session?.inputTokens).toBe(300); // 100 + 200
			expect(session?.outputTokens).toBe(150); // 50 + 100
			expect(session?.cacheCreationTokens).toBe(30); // 10 + 20
			expect(session?.cacheReadTokens).toBe(15); // 5 + 10
			expect(session?.totalCost).toBe(0.03); // 0.01 + 0.02
			expect(session?.lastActivity).toBe('2024-01-01');
		});

		it('tracks versions', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					version: createVersion('1.0.0'),
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					version: createVersion('1.1.0'),
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T18:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					version: createVersion('1.0.0'), // Duplicate version
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'chat.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			const session = result[0];
			expect(session?.versions).toEqual(['1.0.0', '1.1.0']); // Sorted and unique
		});

		it('sorts by last activity descending', async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map(s => [
							s.sessionId,
							{ 'chat.jsonl': JSON.stringify(s.data) },
						]),
					),
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			expect(result[0]?.sessionId).toBe('session3');
			expect(result[1]?.sessionId).toBe('session1');
			expect(result[2]?.sessionId).toBe('session2');
		});

		it('sorts by last activity ascending when order is \'asc\'', async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map(s => [
							s.sessionId,
							{ 'chat.jsonl': JSON.stringify(s.data) },
						]),
					),
				},
			});

			const result = await loadSessionData({
				claudePath: fixture.path,
				order: 'asc',
			});

			expect(result[0]?.sessionId).toBe('session2'); // oldest first
			expect(result[1]?.sessionId).toBe('session1');
			expect(result[2]?.sessionId).toBe('session3'); // newest last
		});

		it('sorts by last activity descending when order is \'desc\'', async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map(s => [
							s.sessionId,
							{ 'chat.jsonl': JSON.stringify(s.data) },
						]),
					),
				},
			});

			const result = await loadSessionData({
				claudePath: fixture.path,
				order: 'desc',
			});

			expect(result[0]?.sessionId).toBe('session3'); // newest first (same as default)
			expect(result[1]?.sessionId).toBe('session1');
			expect(result[2]?.sessionId).toBe('session2'); // oldest last
		});

		it('filters by date range based on last activity', async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map(s => [
							s.sessionId,
							{ 'chat.jsonl': JSON.stringify(s.data) },
						]),
					),
				},
			});

			const result = await loadSessionData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240125',
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.lastActivity).toBe('2024-01-15');
		});
	});

	describe('data-loader cost calculation with real pricing', () => {
		describe('loadDailyUsageData with mixed schemas', () => {
			it('should handle old schema with costUSD', async () => {
				const oldData = {
					timestamp: '2024-01-15T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
					},
					costUSD: 0.05, // Pre-calculated cost
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-old': {
							'session-old': {
								'usage.jsonl': `${JSON.stringify(oldData)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-15');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.totalCost).toBe(0.05);
			});

			it('should calculate cost for new schema with claude-sonnet-4-20250514', async () => {
			// Use a well-known Claude model
				const modelName = createModelName('claude-sonnet-4-20250514');

				const newData = {
					timestamp: '2024-01-16T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 200,
							cache_read_input_tokens: 300,
						},
						model: modelName,
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-new': {
							'session-new': {
								'usage.jsonl': `${JSON.stringify(newData)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-16');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(200);
				expect(results[0]?.cacheReadTokens).toBe(300);

				// Should have calculated some cost
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('should calculate cost for new schema with claude-opus-4-20250514', async () => {
			// Use Claude 4 Opus model
				const modelName = createModelName('claude-opus-4-20250514');

				const newData = {
					timestamp: '2024-01-16T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 200,
							cache_read_input_tokens: 300,
						},
						model: modelName,
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-opus': {
							'session-opus': {
								'usage.jsonl': `${JSON.stringify(newData)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-16');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(200);
				expect(results[0]?.cacheReadTokens).toBe(300);

				// Should have calculated some cost
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('should handle mixed data in same file', async () => {
				const data1 = {
					timestamp: '2024-01-17T10:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				};

				const data2 = {
					timestamp: '2024-01-17T11:00:00Z',
					message: {
						usage: { input_tokens: 200, output_tokens: 100 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				const data3 = {
					timestamp: '2024-01-17T12:00:00Z',
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
				// No costUSD and no model - should be 0 cost
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-mixed': {
							'session-mixed': {
								'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n${JSON.stringify(data3)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-17');
				expect(results[0]?.inputTokens).toBe(600); // 100 + 200 + 300
				expect(results[0]?.outputTokens).toBe(300); // 50 + 100 + 150

				// Total cost should be at least the pre-calculated cost from data1
				expect(results[0]?.totalCost).toBeGreaterThanOrEqual(0.01);
			});

			it('should handle data without model or costUSD', async () => {
				const data = {
					timestamp: '2024-01-18T10:00:00Z',
					message: { usage: { input_tokens: 500, output_tokens: 250 } },
				// No costUSD and no model
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-no-cost': {
							'session-no-cost': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.inputTokens).toBe(500);
				expect(results[0]?.outputTokens).toBe(250);
				expect(results[0]?.totalCost).toBe(0); // 0 cost when no pricing info available
			});
		});

		describe('loadSessionData with mixed schemas', () => {
			it('should handle mixed cost sources in different sessions', async () => {
				const session1Data = {
					timestamp: '2024-01-15T10:00:00Z',
					message: { usage: { input_tokens: 1000, output_tokens: 500 } },
					costUSD: 0.05,
				};

				const session2Data = {
					timestamp: '2024-01-16T10:00:00Z',
					message: {
						usage: { input_tokens: 2000, output_tokens: 1000 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session1: {
								'usage.jsonl': JSON.stringify(session1Data),
							},
							session2: {
								'usage.jsonl': JSON.stringify(session2Data),
							},
						},
					},
				});

				const results = await loadSessionData({ claudePath: fixture.path });

				expect(results).toHaveLength(2);

				// Check session 1
				const session1 = results.find(s => s.sessionId === 'session1');
				expect(session1).toBeTruthy();
				expect(session1?.totalCost).toBe(0.05);

				// Check session 2
				const session2 = results.find(s => s.sessionId === 'session2');
				expect(session2).toBeTruthy();
				expect(session2?.totalCost).toBeGreaterThan(0);
			});

			it('should handle unknown models gracefully', async () => {
				const data = {
					timestamp: '2024-01-19T10:00:00Z',
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: 'unknown-model-xyz',
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-unknown': {
							'session-unknown': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadSessionData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.totalCost).toBe(0); // 0 cost for unknown model
			});
		});

		describe('cached tokens cost calculation', () => {
			it('should correctly calculate costs for all token types with claude-sonnet-4-20250514', async () => {
				const data = {
					timestamp: '2024-01-20T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 2000,
							cache_read_input_tokens: 1500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-cache': {
							'session-cache': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-20');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(2000);
				expect(results[0]?.cacheReadTokens).toBe(1500);

				// Should have calculated cost including cache tokens
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('should correctly calculate costs for all token types with claude-opus-4-20250514', async () => {
				const data = {
					timestamp: '2024-01-20T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 2000,
							cache_read_input_tokens: 1500,
						},
						model: createModelName('claude-opus-4-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-opus-cache': {
							'session-opus-cache': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-20');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(2000);
				expect(results[0]?.cacheReadTokens).toBe(1500);

				// Should have calculated cost including cache tokens
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});
		});

		describe('cost mode functionality', () => {
			it('auto mode: uses costUSD when available, calculates otherwise', async () => {
				const data1 = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: { usage: { input_tokens: 1000, output_tokens: 500 } },
					costUSD: 0.05,
				};

				const data2 = {
					timestamp: '2024-01-01T11:00:00Z',
					message: {
						usage: { input_tokens: 2000, output_tokens: 1000 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'auto',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0.05); // Should include both costs
			});

			it('calculate mode: always calculates from tokens, ignores costUSD', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 99.99, // This should be ignored
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'calculate',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0);
				expect(results[0]?.totalCost).toBeLessThan(1); // Much less than 99.99
			});

			it('display mode: always uses costUSD, even if undefined', async () => {
				const data1 = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				const data2 = {
					timestamp: '2024-01-01T11:00:00Z',
					message: {
						usage: { input_tokens: 2000, output_tokens: 1000 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				// No costUSD - should result in 0 cost
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05); // Only the costUSD from data1
			});

			it('mode works with session data', async () => {
				const sessionData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 99.99,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session1: {
								'usage.jsonl': JSON.stringify(sessionData),
							},
						},
					},
				});

				// Test calculate mode
				const calculateResults = await loadSessionData({
					claudePath: fixture.path,
					mode: 'calculate',
				});
				expect(calculateResults[0]?.totalCost).toBeLessThan(1);

				// Test display mode
				const displayResults = await loadSessionData({
					claudePath: fixture.path,
					mode: 'display',
				});
				expect(displayResults[0]?.totalCost).toBe(99.99);
			});
		});

		describe('pricing data fetching optimization', () => {
			it('should not require model pricing when mode is display', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// In display mode, only pre-calculated costUSD should be used
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05);
			});

			it('should fetch pricing data when mode is calculate', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// This should fetch pricing data (will call real fetch)
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'calculate',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0);
				expect(results[0]?.totalCost).not.toBe(0.05); // Should calculate, not use costUSD
			});

			it('should fetch pricing data when mode is auto', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				// No costUSD, so auto mode will need to calculate
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// This should fetch pricing data (will call real fetch)
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'auto',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('session data should not require model pricing when mode is display', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// In display mode, only pre-calculated costUSD should be used
				const results = await loadSessionData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05);
			});

			it('display mode should work without network access', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: 'some-unknown-model',
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// This test verifies that display mode doesn't try to fetch pricing
				// by using an unknown model that would cause pricing lookup to fail
				// if it were attempted. Since we're in display mode, it should just
				// use the costUSD value.
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05);
			});
		});
	});

	describe('calculateCostForEntry', () => {
		const mockUsageData: UsageData = {
			timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
			message: {
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 100,
				},
				model: createModelName('claude-sonnet-4-20250514'),
			},
			costUSD: 0.05,
		};

		describe('display mode', () => {
			it('should return costUSD when available', async () => {
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'display', fetcher);
				expect(result).toBe(0.05);
			});

			it('should return 0 when costUSD is undefined', async () => {
				const dataWithoutCost = { ...mockUsageData };
				dataWithoutCost.costUSD = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCost, 'display', fetcher);
				expect(result).toBe(0);
			});

			it('should not use model pricing in display mode', async () => {
			// Even with model pricing available, should use costUSD
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'display', fetcher);
				expect(result).toBe(0.05);
			});
		});

		describe('calculate mode', () => {
			it('should calculate cost from tokens when model pricing available', async () => {
			// Use the exact same structure as working integration tests
				const testData: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(testData, 'calculate', fetcher);

				expect(result).toBeGreaterThan(0);
			});

			it('should ignore costUSD in calculate mode', async () => {
				using fetcher = new PricingFetcher();
				const dataWithHighCost = { ...mockUsageData, costUSD: 99.99 };
				const result = await calculateCostForEntry(
					dataWithHighCost,
					'calculate',
					fetcher,
				);

				expect(result).toBeGreaterThan(0);
				expect(result).toBeLessThan(1); // Much less than 99.99
			});

			it('should return 0 when model not available', async () => {
				const dataWithoutModel = { ...mockUsageData };
				dataWithoutModel.message.model = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutModel, 'calculate', fetcher);
				expect(result).toBe(0);
			});

			it('should return 0 when model pricing not found', async () => {
				const dataWithUnknownModel = {
					...mockUsageData,
					message: { ...mockUsageData.message, model: createModelName('unknown-model') },
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(
					dataWithUnknownModel,
					'calculate',
					fetcher,
				);
				expect(result).toBe(0);
			});

			it('should handle missing cache tokens', async () => {
				const dataWithoutCacheTokens: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(
					dataWithoutCacheTokens,
					'calculate',
					fetcher,
				);

				expect(result).toBeGreaterThan(0);
			});
		});

		describe('auto mode', () => {
			it('should use costUSD when available', async () => {
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'auto', fetcher);
				expect(result).toBe(0.05);
			});

			it('should calculate from tokens when costUSD undefined', async () => {
				const dataWithoutCost: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(
					dataWithoutCost,
					'auto',
					fetcher,
				);
				expect(result).toBeGreaterThan(0);
			});

			it('should return 0 when no costUSD and no model', async () => {
				const dataWithoutCostOrModel = { ...mockUsageData };
				dataWithoutCostOrModel.costUSD = undefined;
				dataWithoutCostOrModel.message.model = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCostOrModel, 'auto', fetcher);
				expect(result).toBe(0);
			});

			it('should return 0 when no costUSD and model pricing not found', async () => {
				const dataWithoutCost = { ...mockUsageData };
				dataWithoutCost.costUSD = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCost, 'auto', fetcher);
				expect(result).toBe(0);
			});

			it('should prefer costUSD over calculation even when both available', async () => {
			// Both costUSD and model pricing available, should use costUSD
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'auto', fetcher);
				expect(result).toBe(0.05);
			});
		});

		describe('edge cases', () => {
			it('should handle zero token counts', async () => {
				const dataWithZeroTokens = {
					...mockUsageData,
					message: {
						...mockUsageData.message,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				};
				dataWithZeroTokens.costUSD = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithZeroTokens, 'calculate', fetcher);
				expect(result).toBe(0);
			});

			it('should handle costUSD of 0', async () => {
				const dataWithZeroCost = { ...mockUsageData, costUSD: 0 };
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithZeroCost, 'display', fetcher);
				expect(result).toBe(0);
			});

			it('should handle negative costUSD', async () => {
				const dataWithNegativeCost = { ...mockUsageData, costUSD: -0.01 };
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithNegativeCost, 'display', fetcher);
				expect(result).toBe(-0.01);
			});
		});

		describe('offline mode', () => {
			it('should pass offline flag through loadDailyUsageData', async () => {
				await using fixture = await createFixture({ projects: {} });
				// This test verifies that the offline flag is properly passed through
				// We can't easily mock the internal behavior, but we can verify it doesn't throw
				const result = await loadDailyUsageData({
					claudePath: fixture.path,
					offline: true,
					mode: 'calculate',
				});

				// Should return empty array or valid data without throwing
				expect(Array.isArray(result)).toBe(true);
			});
		});
	});

	describe('loadSessionBlockData', () => {
		it('returns empty array when no files found', async () => {
			await using fixture = await createFixture({ projects: {} });
			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('loads and identifies five-hour blocks correctly', async () => {
			const now = new Date('2024-01-01T10:00:00Z');
			const laterTime = new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour later
			const muchLaterTime = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hours later

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: {
											input_tokens: 1000,
											output_tokens: 500,
										},
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: laterTime.toISOString(),
									message: {
										id: 'msg2',
										usage: {
											input_tokens: 2000,
											output_tokens: 1000,
										},
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req2',
									costUSD: 0.02,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: muchLaterTime.toISOString(),
									message: {
										id: 'msg3',
										usage: {
											input_tokens: 1500,
											output_tokens: 750,
										},
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req3',
									costUSD: 0.015,
									version: createVersion('1.0.0'),
								},
							].map(data => JSON.stringify(data)).join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result.length).toBeGreaterThan(0); // Should have blocks
			expect(result[0]?.entries).toHaveLength(1); // First block has one entry
			// Total entries across all blocks should be 3
			const totalEntries = result.reduce((sum, block) => sum + block.entries.length, 0);
			expect(totalEntries).toBe(3);
		});

		it('handles cost calculation modes correctly', async () => {
			const now = new Date('2024-01-01T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': JSON.stringify({
								timestamp: now.toISOString(),
								message: {
									id: 'msg1',
									usage: {
										input_tokens: 1000,
										output_tokens: 500,
									},
									model: createModelName('claude-sonnet-4-20250514'),
								},
								request: { id: 'req1' },
								costUSD: 0.01,
								version: createVersion('1.0.0'),
							}),
						},
					},
				},
			});

			// Test display mode
			const displayResult = await loadSessionBlockData({
				claudePath: fixture.path,
				mode: 'display',
			});
			expect(displayResult).toHaveLength(1);
			expect(displayResult[0]?.costUSD).toBe(0.01);

			// Test calculate mode
			const calculateResult = await loadSessionBlockData({
				claudePath: fixture.path,
				mode: 'calculate',
			});
			expect(calculateResult).toHaveLength(1);
			expect(calculateResult[0]?.costUSD).toBeGreaterThan(0);
		});

		it('filters by date range correctly', async () => {
			const date1 = new Date('2024-01-01T10:00:00Z');
			const date2 = new Date('2024-01-02T10:00:00Z');
			const date3 = new Date('2024-01-03T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: date1.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: date2.toISOString(),
									message: {
										id: 'msg2',
										usage: { input_tokens: 2000, output_tokens: 1000 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req2',
									costUSD: 0.02,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: date3.toISOString(),
									message: {
										id: 'msg3',
										usage: { input_tokens: 1500, output_tokens: 750 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req3',
									costUSD: 0.015,
									version: createVersion('1.0.0'),
								},
							].map(data => JSON.stringify(data)).join('\n'),
						},
					},
				},
			});

			// Test filtering with since parameter
			const sinceResult = await loadSessionBlockData({
				claudePath: fixture.path,
				since: '20240102',
			});
			expect(sinceResult.length).toBeGreaterThan(0);
			expect(sinceResult.every(block => block.startTime >= date2)).toBe(true);

			// Test filtering with until parameter
			const untilResult = await loadSessionBlockData({
				claudePath: fixture.path,
				until: '20240102',
			});
			expect(untilResult.length).toBeGreaterThan(0);
			// The filter uses formatDate which converts to YYYYMMDD format for comparison
			expect(untilResult.every((block) => {
				const blockDateStr = block.startTime.toISOString().slice(0, 10).replace(/-/g, '');
				return blockDateStr <= '20240102';
			})).toBe(true);
		});

		it('sorts blocks by order parameter', async () => {
			const date1 = new Date('2024-01-01T10:00:00Z');
			const date2 = new Date('2024-01-02T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: date2.toISOString(),
									message: {
										id: 'msg2',
										usage: { input_tokens: 2000, output_tokens: 1000 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req2',
									costUSD: 0.02,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: date1.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
							].map(data => JSON.stringify(data)).join('\n'),
						},
					},
				},
			});

			// Test ascending order
			const ascResult = await loadSessionBlockData({
				claudePath: fixture.path,
				order: 'asc',
			});
			expect(ascResult[0]?.startTime).toEqual(date1);

			// Test descending order
			const descResult = await loadSessionBlockData({
				claudePath: fixture.path,
				order: 'desc',
			});
			expect(descResult[0]?.startTime).toEqual(date2);
		});

		it('handles deduplication correctly', async () => {
			const now = new Date('2024-01-01T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
								// Duplicate entry - should be filtered out
								{
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
							].map(data => JSON.stringify(data)).join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result).toHaveLength(1);
			expect(result[0]?.entries).toHaveLength(1); // Only one entry after deduplication
		});

		it('handles invalid JSON lines gracefully', async () => {
			const now = new Date('2024-01-01T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								'invalid json line',
								JSON.stringify({
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								}),
								'another invalid line',
							].join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result).toHaveLength(1);
			expect(result[0]?.entries).toHaveLength(1);
		});
	});
}

// duplication functionality tests
if (import.meta.vitest != null) {
	describe('deduplication functionality', () => {
		describe('createUniqueHash', () => {
			it('should create hash from message id and request id', () => {
				const data = {
					timestamp: createISOTimestamp('2025-01-10T10:00:00Z'),
					message: {
						id: createMessageId('msg_123'),
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					requestId: createRequestId('req_456'),
				};

				const hash = createUniqueHash(data);
				expect(hash).toBe('msg_123:req_456');
			});

			it('should return null when message id is missing', () => {
				const data = {
					timestamp: createISOTimestamp('2025-01-10T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					requestId: createRequestId('req_456'),
				};

				const hash = createUniqueHash(data);
				expect(hash).toBeNull();
			});

			it('should return null when request id is missing', () => {
				const data = {
					timestamp: createISOTimestamp('2025-01-10T10:00:00Z'),
					message: {
						id: createMessageId('msg_123'),
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
				};

				const hash = createUniqueHash(data);
				expect(hash).toBeNull();
			});
		});

		describe('getEarliestTimestamp', () => {
			it('should extract earliest timestamp from JSONL file', async () => {
				const content = [
					JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', message: { usage: {} } }),
					JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
					JSON.stringify({ timestamp: '2025-01-12T11:00:00Z', message: { usage: {} } }),
				].join('\n');

				await using fixture = await createFixture({
					'test.jsonl': content,
				});

				const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
				expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
			});

			it('should handle files without timestamps', async () => {
				const content = [
					JSON.stringify({ message: { usage: {} } }),
					JSON.stringify({ data: 'no timestamp' }),
				].join('\n');

				await using fixture = await createFixture({
					'test.jsonl': content,
				});

				const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
				expect(timestamp).toBeNull();
			});

			it('should skip invalid JSON lines', async () => {
				const content = [
					'invalid json',
					JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
					'{ broken: json',
				].join('\n');

				await using fixture = await createFixture({
					'test.jsonl': content,
				});

				const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
				expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
			});
		});

		describe('sortFilesByTimestamp', () => {
			it('should sort files by earliest timestamp', async () => {
				await using fixture = await createFixture({
					'file1.jsonl': JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }),
					'file2.jsonl': JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }),
					'file3.jsonl': JSON.stringify({ timestamp: '2025-01-12T10:00:00Z' }),
				});

				const file1 = fixture.getPath('file1.jsonl');
				const file2 = fixture.getPath('file2.jsonl');
				const file3 = fixture.getPath('file3.jsonl');

				const sorted = await sortFilesByTimestamp([file1, file2, file3]);

				expect(sorted).toEqual([file2, file3, file1]); // Chronological order
			});

			it('should place files without timestamps at the end', async () => {
				await using fixture = await createFixture({
					'file1.jsonl': JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }),
					'file2.jsonl': JSON.stringify({ no_timestamp: true }),
					'file3.jsonl': JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }),
				});

				const file1 = fixture.getPath('file1.jsonl');
				const file2 = fixture.getPath('file2.jsonl');
				const file3 = fixture.getPath('file3.jsonl');

				const sorted = await sortFilesByTimestamp([file1, file2, file3]);

				expect(sorted).toEqual([file3, file1, file2]); // file2 without timestamp goes to end
			});
		});

		describe('loadDailyUsageData with deduplication', () => {
			it('should deduplicate entries with same message and request IDs', async () => {
				await using fixture = await createFixture({
					projects: {
						project1: {
							session1: {
								'file1.jsonl': JSON.stringify({
									timestamp: '2025-01-10T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
							session2: {
								'file2.jsonl': JSON.stringify({
									timestamp: '2025-01-15T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
						},
					},
				});

				const data = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				// Should only have one entry for 2025-01-10
				expect(data).toHaveLength(1);
				expect(data[0]?.date).toBe('2025-01-10');
				expect(data[0]?.inputTokens).toBe(100);
				expect(data[0]?.outputTokens).toBe(50);
			});

			it('should process files in chronological order', async () => {
				await using fixture = await createFixture({
					projects: {
						'newer.jsonl': JSON.stringify({
							timestamp: '2025-01-15T10:00:00Z',
							message: {
								id: 'msg_123',
								usage: {
									input_tokens: 200,
									output_tokens: 100,
								},
							},
							requestId: 'req_456',
							costUSD: 0.002,
						}),
						'older.jsonl': JSON.stringify({
							timestamp: '2025-01-10T10:00:00Z',
							message: {
								id: 'msg_123',
								usage: {
									input_tokens: 100,
									output_tokens: 50,
								},
							},
							requestId: 'req_456',
							costUSD: 0.001,
						}),
					},
				});

				const data = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				// Should keep the older entry (100/50 tokens) not the newer one (200/100)
				expect(data).toHaveLength(1);
				expect(data[0]?.date).toBe('2025-01-10');
				expect(data[0]?.inputTokens).toBe(100);
				expect(data[0]?.outputTokens).toBe(50);
			});
		});

		describe('loadSessionData with deduplication', () => {
			it('should deduplicate entries across sessions', async () => {
				await using fixture = await createFixture({
					projects: {
						project1: {
							session1: {
								'file1.jsonl': JSON.stringify({
									timestamp: '2025-01-10T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
							session2: {
								'file2.jsonl': JSON.stringify({
									timestamp: '2025-01-15T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
						},
					},
				});

				const sessions = await loadSessionData({
					claudePath: fixture.path,
					mode: 'display',
				});

				// Session 1 should have the entry
				const session1 = sessions.find(s => s.sessionId === 'session1');
				expect(session1).toBeDefined();
				expect(session1?.inputTokens).toBe(100);
				expect(session1?.outputTokens).toBe(50);

				// Session 2 should either not exist or have 0 tokens (duplicate was skipped)
				const session2 = sessions.find(s => s.sessionId === 'session2');
				if (session2 != null) {
					expect(session2.inputTokens).toBe(0);
					expect(session2.outputTokens).toBe(0);
				}
				else {
				// It's also valid for session2 to not be included if it has no entries
					expect(sessions.length).toBe(1);
				}
			});
		});
	});

	describe('getClaudePaths', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		});

		it('returns paths from environment variable when set', async () => {
			await using fixture1 = await createFixture({
				projects: {},
			});
			await using fixture2 = await createFixture({
				projects: {},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture1.path},${fixture2.path}`);

			const paths = getClaudePaths();
			const normalizedFixture1 = path.resolve(fixture1.path);
			const normalizedFixture2 = path.resolve(fixture2.path);

			expect(paths).toEqual(expect.arrayContaining([normalizedFixture1, normalizedFixture2]));
			// Environment paths should be prioritized
			expect(paths[0]).toBe(normalizedFixture1);
			expect(paths[1]).toBe(normalizedFixture2);
		});

		it('filters out non-existent paths from environment variable', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture.path},/nonexistent/path`);

			const paths = getClaudePaths();
			const normalizedFixture = path.resolve(fixture.path);
			expect(paths).toEqual(expect.arrayContaining([normalizedFixture]));
			expect(paths[0]).toBe(normalizedFixture);
		});

		it('removes duplicates from combined paths', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture.path},${fixture.path}`);

			const paths = getClaudePaths();
			const normalizedFixture = path.resolve(fixture.path);
			// Should only contain the fixture path once (but may include defaults)
			const fixtureCount = paths.filter(p => p === normalizedFixture).length;
			expect(fixtureCount).toBe(1);
		});

		it('returns non-empty array with existing default paths', () => {
			// This test will use real filesystem checks for default paths
			vi.stubEnv('CLAUDE_CONFIG_DIR', '');
			const paths = getClaudePaths();

			expect(Array.isArray(paths)).toBe(true);
			// At least one path should exist in our test environment (CI creates both)
			expect(paths.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('multiple paths integration', () => {
		it('loadDailyUsageData aggregates data from multiple paths', async () => {
			await using fixture1 = await createFixture({
				projects: {
					project1: {
						session1: {
							'usage.jsonl': JSON.stringify({
								timestamp: '2024-01-01T12:00:00Z',
								message: { usage: { input_tokens: 100, output_tokens: 50 } },
								costUSD: 0.01,
							}),
						},
					},
				},
			});

			await using fixture2 = await createFixture({
				projects: {
					project2: {
						session2: {
							'usage.jsonl': JSON.stringify({
								timestamp: '2024-01-01T13:00:00Z',
								message: { usage: { input_tokens: 200, output_tokens: 100 } },
								costUSD: 0.02,
							}),
						},
					},
				},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture1.path},${fixture2.path}`);

			const result = await loadDailyUsageData();
			// Find the specific date we're testing
			const targetDate = result.find(day => day.date === '2024-01-01');
			expect(targetDate).toBeDefined();
			expect(targetDate?.inputTokens).toBe(300);
			expect(targetDate?.outputTokens).toBe(150);
			expect(targetDate?.totalCost).toBe(0.03);
		}, 30000);
	});

	describe('globUsageFiles', () => {
		it('should glob files from multiple paths in parallel with base directories', async () => {
			await using fixture = await createFixture({
				'path1/projects/project1/session1/usage.jsonl': 'data1',
				'path2/projects/project2/session2/usage.jsonl': 'data2',
				'path3/projects/project3/session3/usage.jsonl': 'data3',
			});

			const paths = [
				fixture.getPath('path1'),
				fixture.getPath('path2'),
				fixture.getPath('path3'),
			];

			const results = await globUsageFiles(paths);

			expect(results).toHaveLength(3);
			expect(results.some(r => r.file.includes('project1'))).toBe(true);
			expect(results.some(r => r.file.includes('project2'))).toBe(true);
			expect(results.some(r => r.file.includes('project3'))).toBe(true);

			// Check base directories are included
			const result1 = results.find(r => r.file.includes('project1'));
			expect(result1?.baseDir).toContain('path1/projects');
		});

		it('should handle errors gracefully and return empty array for failed paths', async () => {
			await using fixture = await createFixture({
				'valid/projects/project1/session1/usage.jsonl': 'data1',
			});

			const paths = [
				fixture.getPath('valid'),
				fixture.getPath('nonexistent'), // This path doesn't exist
			];

			const results = await globUsageFiles(paths);

			expect(results).toHaveLength(1);
			expect(results.at(0)?.file).toContain('project1');
		});

		it('should return empty array when no files found', async () => {
			await using fixture = await createFixture({
				'empty/projects': {}, // Empty directory
			});

			const paths = [fixture.getPath('empty')];
			const results = await globUsageFiles(paths);

			expect(results).toEqual([]);
		});

		it('should handle multiple files from same base directory', async () => {
			await using fixture = await createFixture({
				'path1/projects/project1/session1/usage.jsonl': 'data1',
				'path1/projects/project1/session2/usage.jsonl': 'data2',
				'path1/projects/project2/session1/usage.jsonl': 'data3',
			});

			const paths = [fixture.getPath('path1')];
			const results = await globUsageFiles(paths);

			expect(results).toHaveLength(3);
			expect(results.every(r => r.baseDir.includes('path1/projects'))).toBe(true);
		});
	});

	// Test for calculateContextTokens
	describe('calculateContextTokens', async () => {
		it('returns null when transcript cannot be read', async () => {
			const result = await calculateContextTokens('/nonexistent/path.jsonl');
			expect(result).toBeNull();
		});
		const { createFixture } = await import('fs-fixture');
		it('parses latest assistant line and excludes output tokens', async () => {
			await using fixture = await createFixture({
				'transcript.jsonl': [
					JSON.stringify({ type: 'user', message: {} }),
					JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, output_tokens: 999 } } }),
					JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2000, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } }),
				].join('\n'),
			});
			const res = await calculateContextTokens(fixture.getPath('transcript.jsonl'));
			expect(res).not.toBeNull();
			// Should pick the last assistant line and exclude output tokens
			expect(res?.inputTokens).toBe(2000 + 100 + 50);
			expect(res?.percentage).toBeGreaterThan(0);
		});

		it('handles missing cache fields gracefully', async () => {
			await using fixture = await createFixture({
				'transcript.jsonl': [
					JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000 } } }),
				].join('\n'),
			});
			const res = await calculateContextTokens(fixture.getPath('transcript.jsonl'));
			expect(res).not.toBeNull();
			expect(res?.inputTokens).toBe(1000);
			expect(res?.percentage).toBeGreaterThan(0);
		});

		it('clamps percentage to 0-100 range', async () => {
			await using fixture = await createFixture({
				'transcript.jsonl': [
					JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 300_000 } } }),
				].join('\n'),
			});
			const res = await calculateContextTokens(fixture.getPath('transcript.jsonl'));
			expect(res).not.toBeNull();
			expect(res?.percentage).toBe(100); // Should be clamped to 100
		});
	});
}
