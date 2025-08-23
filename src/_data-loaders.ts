/**
 * @fileoverview Main data loading functions for Claude Code usage analysis
 *
 * This module contains the primary data loading functions that process JSONL files
 * and aggregate usage data into various formats (daily, monthly, session-based, etc.).
 *
 * @module _data-loaders
 */

import type { IntRange, TupleToUnion } from 'type-fest';
import type { WEEK_DAYS } from './_consts.ts';
import type {
	BucketUsage,
	DailyUsage,
	LoadOptions,
	MonthlyUsage,
	UsageData,
	WeeklyUsage,
} from './_data-schemas.ts';
import type {
	Bucket,
	ModelName,
	WeeklyDate,
} from './_types.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Result } from '@praha/byethrow';
import { groupBy, uniq } from 'es-toolkit';
import { glob } from 'tinyglobby';
import {
	aggregateModelBreakdowns,
	createModelBreakdowns,
} from './_data-aggregation.ts';
import { transcriptMessageSchema, usageDataSchema } from './_data-schemas.ts';
import {
	calculateCostForEntry,
	getClaudePaths,
	sortByDate,
} from './_data-utils.ts';

import {
	createBucket,
	createMonthlyDate,
	createWeeklyDate,
} from './_types.ts';
import { logger } from './logger.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

type WeekDay = TupleToUnion<typeof WEEK_DAYS>;
type DayOfWeek = IntRange<0, typeof WEEK_DAYS['length']>; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

/**
 * @param date - The date to get the week for
 * @param startDay - The day to start the week on (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 * @returns The date of the first day of the week for the given date
 */
function getDateWeek(date: Date, startDay: DayOfWeek): WeeklyDate {
	const d = new Date(date);
	const day = d.getDay();
	const shift = (day - startDay + 7) % 7;
	d.setDate(d.getDate() - shift);

	return createWeeklyDate(d.toISOString().substring(0, 10));
}

/**
 * Convert day name to number (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
function getDayNumber(day: WeekDay): DayOfWeek {
	const dayMap = {
		sunday: 0,
		monday: 1,
		tuesday: 2,
		wednesday: 3,
		thursday: 4,
		friday: 5,
		saturday: 6,
	} as const satisfies Record<WeekDay, DayOfWeek>;
	return dayMap[day];
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
	options?: { mode?: import('./_types.ts').CostMode; offline?: boolean },
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

export async function loadBucketUsageData(
	groupingFn: (data: DailyUsage) => Bucket,
	options?: LoadOptions,
): Promise<BucketUsage[]> {
	// Import loadDailyUsageData from data-loader.ts to avoid circular imports
	const { loadDailyUsageData } = await import('./data-loader.ts');
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

// Note: loadDailyUsageData, loadSessionData, and loadSessionBlockData are implemented in data-loader.ts
// to avoid circular imports and maintain the main entry point.
