import type { CostMode, SortOrder } from './types.internal.ts';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { unreachable } from '@core/errorutil';
import { sort } from 'fast-sort';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	PricingFetcher,
} from './pricing-fetcher.ts';
import { groupBy } from './utils.internal.ts';

export function getDefaultClaudePath(): string {
	return path.join(homedir(), '.claude');
}

export const UsageDataSchema = v.object({
	timestamp: v.string(),
	version: v.optional(v.string()), // Claude Code version
	message: v.object({
		usage: v.object({
			input_tokens: v.number(),
			output_tokens: v.number(),
			cache_creation_input_tokens: v.optional(v.number()),
			cache_read_input_tokens: v.optional(v.number()),
		}),
		model: v.optional(v.string()), // Model is inside message object
	}),
	costUSD: v.optional(v.number()), // Made optional for new schema
});

export type UsageData = v.InferOutput<typeof UsageDataSchema>;

export const ModelBreakdownSchema = v.object({
	modelName: v.string(),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	cost: v.number(),
});

export type ModelBreakdown = v.InferOutput<typeof ModelBreakdownSchema>;

export const DailyUsageSchema = v.object({
	date: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD format
	),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	modelsUsed: v.array(v.string()),
	modelBreakdowns: v.array(ModelBreakdownSchema),
});

export type DailyUsage = v.InferOutput<typeof DailyUsageSchema>;

export const SessionUsageSchema = v.object({
	sessionId: v.string(),
	projectPath: v.string(),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	lastActivity: v.string(),
	versions: v.array(v.string()), // List of unique versions used in this session
	modelsUsed: v.array(v.string()),
	modelBreakdowns: v.array(ModelBreakdownSchema),
});

export type SessionUsage = v.InferOutput<typeof SessionUsageSchema>;

export const MonthlyUsageSchema = v.object({
	month: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}$/), // YYYY-MM format
	),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	modelsUsed: v.array(v.string()),
	modelBreakdowns: v.array(ModelBreakdownSchema),
});

export type MonthlyUsage = v.InferOutput<typeof MonthlyUsageSchema>;

export function formatDate(dateStr: string): string {
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

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
			return fetcher.calculateCostFromTokens(data.message.usage, data.message.model);
		}
		return 0;
	}

	if (mode === 'auto') {
		// Auto mode: use costUSD if available, otherwise calculate
		if (data.costUSD != null) {
			return data.costUSD;
		}

		if (data.message.model != null) {
			return fetcher.calculateCostFromTokens(data.message.usage, data.message.model);
		}

		return 0;
	}

	unreachable(mode);
}

export type DateFilter = {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
};

export type LoadOptions = {
	claudePath?: string; // Custom path to Claude data directory
	mode?: CostMode; // Cost calculation mode
	order?: SortOrder; // Sort order for dates
} & DateFilter;

export async function loadDailyUsageData(
	options?: LoadOptions,
): Promise<DailyUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, 'projects');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher();

	// Collect all valid data entries first
	const allEntries: { data: UsageData; date: string; cost: number; model: string | undefined }[] = [];

	for (const file of files) {
		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				const date = formatDate(data.timestamp);
				// If fetcher is available, calculate cost based on mode and tokens
				// If fetcher is null, use pre-calculated costUSD or default to 0
				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({ data, date, cost, model: data.message.model });
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Group by date using Object.groupBy
	const groupedByDate = groupBy(allEntries, entry => entry.date);

	// Aggregate each group
	const results = Object.entries(groupedByDate)
		.map(([date, entries]) => {
			if (entries == null) {
				return undefined;
			}

			// Aggregate by model first
			const modelAggregates = new Map<string, {
				inputTokens: number;
				outputTokens: number;
				cacheCreationTokens: number;
				cacheReadTokens: number;
				cost: number;
			}>();

			for (const entry of entries) {
				const modelName = entry.model ?? 'unknown';
				// Skip synthetic model
				if (modelName === '<synthetic>') {
					continue;
				}
				const existing = modelAggregates.get(modelName) ?? {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0,
				};

				modelAggregates.set(modelName, {
					inputTokens: existing.inputTokens + (entry.data.message.usage.input_tokens ?? 0),
					outputTokens: existing.outputTokens + (entry.data.message.usage.output_tokens ?? 0),
					cacheCreationTokens: existing.cacheCreationTokens + (entry.data.message.usage.cache_creation_input_tokens ?? 0),
					cacheReadTokens: existing.cacheReadTokens + (entry.data.message.usage.cache_read_input_tokens ?? 0),
					cost: existing.cost + entry.cost,
				});
			}

			// Create model breakdowns
			const modelBreakdowns: ModelBreakdown[] = Array.from(modelAggregates.entries())
				.map(([modelName, stats]) => ({
					modelName,
					...stats,
				}))
				.sort((a, b) => b.cost - a.cost); // Sort by cost descending

			// Calculate totals
			const totals = entries.reduce(
				(acc, entry) => ({
					inputTokens:
						acc.inputTokens + (entry.data.message.usage.input_tokens ?? 0),
					outputTokens:
						acc.outputTokens + (entry.data.message.usage.output_tokens ?? 0),
					cacheCreationTokens:
						acc.cacheCreationTokens
						+ (entry.data.message.usage.cache_creation_input_tokens ?? 0),
					cacheReadTokens:
						acc.cacheReadTokens
						+ (entry.data.message.usage.cache_read_input_tokens ?? 0),
					totalCost: acc.totalCost + entry.cost,
				}),
				{
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			);

			const modelsUsed = [...new Set(entries.map(e => e.model).filter((m): m is string => m != null && m !== '<synthetic>'))];

			return {
				date,
				...totals,
				modelsUsed,
				modelBreakdowns,
			};
		})
		.filter(item => item != null)
		.filter((item) => {
			// Filter by date range if specified
			if (options?.since != null || options?.until != null) {
				const dateStr = item.date.replace(/-/g, ''); // Convert to YYYYMMDD
				if (options.since != null && dateStr < options.since) {
					return false;
				}
				if (options.until != null && dateStr > options.until) {
					return false;
				}
			}
			return true;
		});

	// Sort by date based on order option (default to descending)
	const sortOrder = options?.order ?? 'desc';
	const sortedResults = sort(results);
	switch (sortOrder) {
		case 'desc':
			return sortedResults.desc(item => new Date(item.date).getTime());
		case 'asc':
			return sortedResults.asc(item => new Date(item.date).getTime());
		default:
			unreachable(sortOrder);
	}
}

export async function loadSessionData(
	options?: LoadOptions,
): Promise<SessionUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, 'projects');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher();

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

	for (const file of files) {
		// Extract session info from file path
		const relativePath = path.relative(claudeDir, file);
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
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

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
			const versionSet = new Set<string>();
			for (const entry of entries) {
				if (entry.data.version != null) {
					versionSet.add(entry.data.version);
				}
			}

			// Aggregate by model
			const modelAggregates = new Map<string, {
				inputTokens: number;
				outputTokens: number;
				cacheCreationTokens: number;
				cacheReadTokens: number;
				cost: number;
			}>();

			for (const entry of entries) {
				const modelName = entry.model ?? 'unknown';
				// Skip synthetic model
				if (modelName === '<synthetic>') {
					continue;
				}
				const existing = modelAggregates.get(modelName) ?? {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0,
				};

				modelAggregates.set(modelName, {
					inputTokens: existing.inputTokens + (entry.data.message.usage.input_tokens ?? 0),
					outputTokens: existing.outputTokens + (entry.data.message.usage.output_tokens ?? 0),
					cacheCreationTokens: existing.cacheCreationTokens + (entry.data.message.usage.cache_creation_input_tokens ?? 0),
					cacheReadTokens: existing.cacheReadTokens + (entry.data.message.usage.cache_read_input_tokens ?? 0),
					cost: existing.cost + entry.cost,
				});
			}

			// Create model breakdowns
			const modelBreakdowns: ModelBreakdown[] = Array.from(modelAggregates.entries())
				.map(([modelName, stats]) => ({
					modelName,
					...stats,
				}))
				.sort((a, b) => b.cost - a.cost);

			// Calculate totals
			const totals = entries.reduce(
				(acc, entry) => ({
					inputTokens:
						acc.inputTokens + (entry.data.message.usage.input_tokens ?? 0),
					outputTokens:
						acc.outputTokens + (entry.data.message.usage.output_tokens ?? 0),
					cacheCreationTokens:
						acc.cacheCreationTokens
						+ (entry.data.message.usage.cache_creation_input_tokens ?? 0),
					cacheReadTokens:
						acc.cacheReadTokens
						+ (entry.data.message.usage.cache_read_input_tokens ?? 0),
					totalCost: acc.totalCost + entry.cost,
				}),
				{
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			);

			const modelsUsed = [...new Set(entries.map(e => e.model).filter((m): m is string => m != null && m !== '<synthetic>'))];

			return {
				sessionId: latestEntry.sessionId,
				projectPath: latestEntry.projectPath,
				...totals,
				lastActivity: formatDate(latestEntry.timestamp),
				versions: Array.from(versionSet).sort(),
				modelsUsed,
				modelBreakdowns,
			};
		})
		.filter(item => item != null)
		.filter((item) => {
			// Filter by date range if specified
			if (options?.since != null || options?.until != null) {
				const dateStr = item.lastActivity.replace(/-/g, ''); // Convert to YYYYMMDD
				if (options.since != null && dateStr < options.since) {
					return false;
				}
				if (options.until != null && dateStr > options.until) {
					return false;
				}
			}
			return true;
		});

	// Sort by last activity based on order option (default to descending)
	const sortOrder = options?.order ?? 'desc';
	const sortedResults = sort(results);
	return sortOrder === 'desc'
		? sortedResults.desc(item => new Date(item.lastActivity).getTime())
		: sortedResults.asc(item => new Date(item.lastActivity).getTime());
}

export async function loadMonthlyUsageData(
	options?: LoadOptions,
): Promise<MonthlyUsage[]> {
	const dailyData = await loadDailyUsageData(options);

	// Group daily data by month using Object.groupBy
	const groupedByMonth = groupBy(dailyData, data =>
		data.date.substring(0, 7));

	// Aggregate each month group
	const monthlyArray: MonthlyUsage[] = [];
	for (const [month, dailyEntries] of Object.entries(groupedByMonth)) {
		if (dailyEntries == null) {
			continue;
		}

		// Aggregate model breakdowns across all days
		const modelAggregates = new Map<string, {
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			cost: number;
		}>();

		for (const daily of dailyEntries) {
			for (const breakdown of daily.modelBreakdowns) {
				// Skip synthetic model
				if (breakdown.modelName === '<synthetic>') {
					continue;
				}
				const existing = modelAggregates.get(breakdown.modelName) ?? {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0,
				};

				modelAggregates.set(breakdown.modelName, {
					inputTokens: existing.inputTokens + breakdown.inputTokens,
					outputTokens: existing.outputTokens + breakdown.outputTokens,
					cacheCreationTokens: existing.cacheCreationTokens + breakdown.cacheCreationTokens,
					cacheReadTokens: existing.cacheReadTokens + breakdown.cacheReadTokens,
					cost: existing.cost + breakdown.cost,
				});
			}
		}

		// Create model breakdowns
		const modelBreakdowns: ModelBreakdown[] = Array.from(modelAggregates.entries())
			.map(([modelName, stats]) => ({
				modelName,
				...stats,
			}))
			.sort((a, b) => b.cost - a.cost);

		// Collect unique models
		const modelsSet = new Set<string>();
		for (const data of dailyEntries) {
			for (const model of data.modelsUsed) {
				// Skip synthetic model
				if (model !== '<synthetic>') {
					modelsSet.add(model);
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
		const monthlyUsage: MonthlyUsage = {
			month,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			cacheReadTokens: totalCacheReadTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
			modelBreakdowns,
		};

		monthlyArray.push(monthlyUsage);
	}

	// Sort by month based on sortOrder
	const sortOrder = options?.order ?? 'desc';
	const sortedMonthly = sort(monthlyArray);
	return sortOrder === 'desc'
		? sortedMonthly.desc(item => item.month)
		: sortedMonthly.asc(item => item.month);
}
