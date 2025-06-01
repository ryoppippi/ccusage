import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sort } from "fast-sort";
import { glob } from "tinyglobby";
import * as v from "valibot";

export const getDefaultClaudePath = () => path.join(homedir(), ".claude");

export const UsageDataSchema = v.object({
	timestamp: v.string(),
	message: v.object({
		usage: v.object({
			input_tokens: v.number(),
			output_tokens: v.number(),
			cache_creation_input_tokens: v.optional(v.number()),
			cache_read_input_tokens: v.optional(v.number()),
		}),
	}),
	costUSD: v.number(),
});

export type UsageData = v.InferOutput<typeof UsageDataSchema>;

export const DailyUsageSchema = v.object({
	date: v.string(),
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
});

export type SessionUsage = v.InferOutput<typeof SessionUsageSchema>;

export const formatDate = (dateStr: string): string => {
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
};

export interface DateFilter {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
}

export interface LoadOptions extends DateFilter {
	claudePath?: string; // Custom path to Claude data directory
}

export async function loadUsageData(
	options?: LoadOptions,
): Promise<DailyUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, "projects");
	const files = await glob(["**/*.jsonl"], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	const dailyMap = new Map<string, DailyUsage>();

	for (const file of files) {
		const content = await readFile(file, "utf-8");
		const lines = content
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				const date = formatDate(data.timestamp);
				const existing = dailyMap.get(date) || {
					date,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				};

				existing.inputTokens += data.message.usage.input_tokens || 0;
				existing.outputTokens += data.message.usage.output_tokens || 0;
				existing.cacheCreationTokens +=
					data.message.usage.cache_creation_input_tokens || 0;
				existing.cacheReadTokens +=
					data.message.usage.cache_read_input_tokens || 0;
				existing.totalCost += data.costUSD || 0;

				dailyMap.set(date, existing);
			} catch (e) {
				// Skip invalid JSON lines
			}
		}
	}

	// Convert map to array and filter by date range
	let results = Array.from(dailyMap.values());

	if (options?.since || options?.until) {
		results = results.filter((data) => {
			const dateStr = data.date.replace(/-/g, ""); // Convert to YYYYMMDD
			if (options.since && dateStr < options.since) return false;
			if (options.until && dateStr > options.until) return false;
			return true;
		});
	}

	// Sort by date descending
	return sort(results).desc((item) => new Date(item.date).getTime());
}

export async function loadSessionData(
	options?: LoadOptions,
): Promise<SessionUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, "projects");
	const files = await glob(["**/*.jsonl"], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	const sessionMap = new Map<string, SessionUsage>();

	for (const file of files) {
		// Extract session info from file path
		const relativePath = path.relative(claudeDir, file);
		const parts = relativePath.split(path.sep);

		// Session ID is the directory name containing the JSONL file
		const sessionId = parts[parts.length - 2];
		// Project path is everything before the session ID
		const projectPath = parts.slice(0, -2).join(path.sep);

		const content = await readFile(file, "utf-8");
		const lines = content
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
		let lastTimestamp = "";

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				const key = `${projectPath}/${sessionId}`;
				const existing = sessionMap.get(key) || {
					sessionId: sessionId || "unknown",
					projectPath: projectPath || "Unknown Project",
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					lastActivity: "",
				};

				existing.inputTokens += data.message.usage.input_tokens || 0;
				existing.outputTokens += data.message.usage.output_tokens || 0;
				existing.cacheCreationTokens +=
					data.message.usage.cache_creation_input_tokens || 0;
				existing.cacheReadTokens +=
					data.message.usage.cache_read_input_tokens || 0;
				existing.totalCost += data.costUSD || 0;

				// Keep track of the latest timestamp
				if (data.timestamp > lastTimestamp) {
					lastTimestamp = data.timestamp;
					existing.lastActivity = formatDate(data.timestamp);
				}

				sessionMap.set(key, existing);
			} catch (e) {
				// Skip invalid JSON lines
			}
		}
	}

	// Convert map to array and filter by date range
	let results = Array.from(sessionMap.values());

	if (options?.since || options?.until) {
		results = results.filter((session) => {
			const dateStr = session.lastActivity.replace(/-/g, ""); // Convert to YYYYMMDD
			if (options.since && dateStr < options.since) return false;
			if (options.until && dateStr > options.until) return false;
			return true;
		});
	}

	// Sort by total cost descending
	return sort(results).desc((item) => item.totalCost);
}
