import type { CostMode, CurrentSessionInfo, SessionWindow, SessionWindowStats, SortOrder } from './types.internal.ts';
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
	const allEntries: { data: UsageData; date: string; cost: number }[] = [];

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

				allEntries.push({ data, date, cost });
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

			return entries.reduce(
				(acc, entry) => ({
					date,
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
					date,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			);
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

			// Aggregate totals
			const aggregated = entries.reduce(
				(acc, entry) => ({
					sessionId: latestEntry.sessionId,
					projectPath: latestEntry.projectPath,
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
					lastActivity: formatDate(latestEntry.timestamp),
					versions: Array.from(versionSet).sort(),
				}),
				{
					sessionId: latestEntry.sessionId,
					projectPath: latestEntry.projectPath,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					lastActivity: formatDate(latestEntry.timestamp),
					versions: Array.from(versionSet).sort(),
				},
			);

			return aggregated;
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
	const monthlyArray = Object.entries(groupedByMonth)
		.map(([month, dailyEntries]) => {
			if (dailyEntries == null) {
				return undefined;
			}

			return dailyEntries.reduce(
				(acc, data) => ({
					month,
					inputTokens: acc.inputTokens + data.inputTokens,
					outputTokens: acc.outputTokens + data.outputTokens,
					cacheCreationTokens:
						acc.cacheCreationTokens + data.cacheCreationTokens,
					cacheReadTokens: acc.cacheReadTokens + data.cacheReadTokens,
					totalCost: acc.totalCost + data.totalCost,
				}),
				{
					month,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			);
		})
		.filter(item => item != null);

	// Sort by month based on sortOrder
	const sortOrder = options?.order ?? 'desc';
	const sortedMonthly = sort(monthlyArray);
	return sortOrder === 'desc'
		? sortedMonthly.desc(item => item.month)
		: sortedMonthly.asc(item => item.month);
}

/**
 * Get the 5-hour window ID for a given timestamp
 * Claude Max plan sessions are 5-hour windows starting from first message
 */
function getSessionWindowId(timestamp: string): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');

	// Calculate which 5-hour window this timestamp falls into
	const hour = date.getHours();
	const windowStartHour = Math.floor(hour / 5) * 5;
	const windowStartHourStr = String(windowStartHour).padStart(2, '0');

	return `${year}-${month}-${day}-${windowStartHourStr}`;
}

/**
 * Check if a timestamp falls within a 5-hour window starting from windowStart
 */
function isWithinSessionWindow(timestamp: string, windowStart: Date): boolean {
	const messageTime = new Date(timestamp);
	const windowEnd = new Date(windowStart.getTime() + 5 * 60 * 60 * 1000); // Add 5 hours
	return messageTime >= windowStart && messageTime < windowEnd;
}

/**
 * Calculate current session time remaining information
 */
function calculateCurrentSessionInfo(allWindows: SessionWindow[]): CurrentSessionInfo {
	if (allWindows.length === 0) {
		return {
			hasActiveSession: false,
			timeRemainingMs: 0,
			timeRemainingFormatted: 'No active session',
		};
	}

	// Find the most recent window (by start time)
	const mostRecentWindow = allWindows.reduce((latest, current) =>
		new Date(current.startTime) > new Date(latest.startTime) ? current : latest,
	);

	const now = new Date();
	const sessionStart = new Date(mostRecentWindow.startTime);
	const sessionEnd = new Date(sessionStart.getTime() + 5 * 60 * 60 * 1000); // Add 5 hours

	// Check if the session is still active (within 5 hours)
	if (now < sessionEnd) {
		const timeRemainingMs = sessionEnd.getTime() - now.getTime();
		const hours = Math.floor(timeRemainingMs / (1000 * 60 * 60));
		const minutes = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));

		let timeRemainingFormatted: string;
		if (hours > 0) {
			timeRemainingFormatted = `${hours}h ${minutes}m`;
		}
		else {
			timeRemainingFormatted = `${minutes}m`;
		}

		return {
			hasActiveSession: true,
			timeRemainingMs,
			timeRemainingFormatted,
			activeWindow: mostRecentWindow,
		};
	}

	return {
		hasActiveSession: false,
		timeRemainingMs: 0,
		timeRemainingFormatted: 'No active session',
	};
}

export async function loadSessionWindowData(
	options?: LoadOptions,
): Promise<SessionWindowStats[]> {
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

	// Collect all valid data entries with session window info
	const allEntries: Array<{
		data: UsageData;
		timestamp: Date;
		cost: number;
		conversationId: string; // Unique conversation identifier
	}> = [];

	for (const file of files) {
		// Extract conversation ID from file path for counting unique conversations
		const relativePath = path.relative(claudeDir, file);
		const conversationId = relativePath.replace(/\.jsonl$/, '');

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

				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({
					data,
					timestamp: new Date(data.timestamp),
					cost,
					conversationId,
				});
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Sort entries by timestamp to process sessions chronologically
	const sortedEntries = sort(allEntries).asc(entry => entry.timestamp.getTime());

	// Group messages into 5-hour session windows
	const sessionWindows = new Map<string, {
		windowId: string;
		startTime: Date;
		endTime: Date;
		entries: typeof allEntries;
		conversationIds: Set<string>;
	}>();

	for (const entry of sortedEntries) {
		const windowId = getSessionWindowId(entry.data.timestamp);

		// Check if this message should start a new session window or extend an existing one
		let assignedWindow = sessionWindows.get(windowId);

		// If no window exists for this time slot, create one
		if (assignedWindow == null) {
			assignedWindow = {
				windowId,
				startTime: entry.timestamp,
				endTime: entry.timestamp,
				entries: [],
				conversationIds: new Set(),
			};
			sessionWindows.set(windowId, assignedWindow);
		}

		// Check if this message falls within the 5-hour window from the first message
		if (isWithinSessionWindow(entry.data.timestamp, assignedWindow.startTime)) {
			// Add to existing window
			assignedWindow.entries.push(entry);
			assignedWindow.conversationIds.add(entry.conversationId);
			if (entry.timestamp > assignedWindow.endTime) {
				assignedWindow.endTime = entry.timestamp;
			}
		}
		else {
			// This message starts a new session window
			// Find the next available window slot
			let newWindowStart = entry.timestamp;
			let newWindowId = getSessionWindowId(entry.data.timestamp);

			// Ensure we don't overlap with existing windows
			while (sessionWindows.has(newWindowId)) {
				newWindowStart = new Date(newWindowStart.getTime() + 5 * 60 * 60 * 1000);
				newWindowId = getSessionWindowId(newWindowStart.toISOString());
			}

			const newWindow = {
				windowId: newWindowId,
				startTime: entry.timestamp,
				endTime: entry.timestamp,
				entries: [entry],
				conversationIds: new Set([entry.conversationId]),
			};
			sessionWindows.set(newWindowId, newWindow);
		}
	}

	// Convert session windows to SessionWindow objects and group by month
	const processedWindows: SessionWindow[] = Array.from(sessionWindows.values()).map((window) => {
		const totalTokens = window.entries.reduce((acc, entry) => ({
			input: acc.input + (entry.data.message.usage.input_tokens ?? 0),
			output: acc.output + (entry.data.message.usage.output_tokens ?? 0),
			cacheCreation: acc.cacheCreation + (entry.data.message.usage.cache_creation_input_tokens ?? 0),
			cacheRead: acc.cacheRead + (entry.data.message.usage.cache_read_input_tokens ?? 0),
		}), { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

		const totalCost = window.entries.reduce((acc, entry) => acc + entry.cost, 0);

		return {
			windowId: window.windowId,
			startTime: window.startTime.toISOString(),
			endTime: window.endTime.toISOString(),
			inputTokens: totalTokens.input,
			outputTokens: totalTokens.output,
			cacheCreationTokens: totalTokens.cacheCreation,
			cacheReadTokens: totalTokens.cacheRead,
			totalCost,
			messageCount: window.entries.length,
			conversationCount: window.conversationIds.size,
		};
	});

	// Filter windows by date range if specified
	const filteredWindows = processedWindows.filter((window) => {
		if (options?.since != null || options?.until != null) {
			const windowDate = window.startTime.substring(0, 10).replace(/-/g, ''); // YYYYMMDD
			if (options.since != null && windowDate < options.since) {
				return false;
			}
			if (options.until != null && windowDate > options.until) {
				return false;
			}
		}
		return true;
	});

	// Group windows by month
	const groupedByMonth = groupBy(filteredWindows, window => window.startTime.substring(0, 7));

	// Create monthly stats
	const monthlyStats = Object.entries(groupedByMonth)
		.map(([month, windows]) => {
			if (windows == null) {
				return undefined;
			}

			const totalSessions = windows.length;
			const remainingSessions = Math.max(0, 50 - totalSessions);
			const utilizationPercent = (totalSessions / 50) * 100;

			const totals = windows.reduce((acc, window) => ({
				cost: acc.cost + window.totalCost,
				tokens: acc.tokens + window.inputTokens + window.outputTokens,
			}), { cost: 0, tokens: 0 });

			// Calculate current session info for this month's windows
			const currentSessionInfo = calculateCurrentSessionInfo(windows);

			return {
				month,
				totalSessions,
				remainingSessions,
				utilizationPercent,
				totalCost: totals.cost,
				totalTokens: totals.tokens,
				averageCostPerSession: totalSessions > 0 ? totals.cost / totalSessions : 0,
				averageTokensPerSession: totalSessions > 0 ? totals.tokens / totalSessions : 0,
				windows: sort(windows)[options?.order === 'asc' ? 'asc' : 'desc'](w => new Date(w.startTime).getTime()),
				currentSession: currentSessionInfo,
			};
		})
		.filter(item => item != null);

	// Sort monthly stats by month
	const sortOrder = options?.order ?? 'desc';
	const sortedStats = sort(monthlyStats);
	return sortOrder === 'desc'
		? sortedStats.desc(item => item.month)
		: sortedStats.asc(item => item.month);
}
