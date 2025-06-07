import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sort } from "fast-sort";
import { glob } from "tinyglobby";
import * as v from "valibot";
import {
	type ModelPricing,
	calculateCostFromTokens,
	fetchModelPricing,
	getModelPricing,
} from "./pricing-fetcher.ts";
import type { CostMode } from "./types.ts";

export const getDefaultClaudePath = () => path.join(homedir(), ".claude");

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
	versions: v.array(v.string()), // List of unique versions used in this session
});

export type SessionUsage = v.InferOutput<typeof SessionUsageSchema>;

export const MonthlyUsageSchema = v.object({
	month: v.string(), // YYYY-MM format
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
});

export type MonthlyUsage = v.InferOutput<typeof MonthlyUsageSchema>;

export const formatDate = (dateStr: string): string => {
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
};

export const calculateCostForEntry = (
	data: UsageData,
	mode: CostMode,
	modelPricing: Record<string, ModelPricing>,
): number => {
	if (mode === "display") {
		// Always use costUSD, even if undefined
		return data.costUSD ?? 0;
	}

	if (mode === "calculate") {
		// Always calculate from tokens
		if (data.message.model) {
			const pricing = getModelPricing(data.message.model, modelPricing);
			if (pricing) {
				return calculateCostFromTokens(data.message.usage, pricing);
			}
		}
		return 0;
	}

	// Auto mode: use costUSD if available, otherwise calculate
	if (data.costUSD !== undefined) {
		return data.costUSD;
	}

	if (data.message.model) {
		const pricing = getModelPricing(data.message.model, modelPricing);
		if (pricing) {
			return calculateCostFromTokens(data.message.usage, pricing);
		}
	}

	return 0;
};

export interface DateFilter {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
}

export interface LoadOptions extends DateFilter {
	claudePath?: string; // Custom path to Claude data directory
	mode?: CostMode; // Cost calculation mode
}

export async function loadDailyUsageData(
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

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode || "auto";
	const modelPricing = mode === "display" ? {} : await fetchModelPricing();

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

				existing.inputTokens += data.message.usage.input_tokens ?? 0;
				existing.outputTokens += data.message.usage.output_tokens ?? 0;
				existing.cacheCreationTokens +=
					data.message.usage.cache_creation_input_tokens ?? 0;
				existing.cacheReadTokens +=
					data.message.usage.cache_read_input_tokens ?? 0;

				// Calculate cost based on mode
				const cost = calculateCostForEntry(data, mode, modelPricing);
				existing.totalCost += cost;

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

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode || "auto";
	const modelPricing = mode === "display" ? {} : await fetchModelPricing();

	const sessionMap = new Map<
		string,
		SessionUsage & { versionSet: Set<string> }
	>();

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
					versions: [],
					versionSet: new Set<string>(),
				};

				existing.inputTokens += data.message.usage.input_tokens ?? 0;
				existing.outputTokens += data.message.usage.output_tokens ?? 0;
				existing.cacheCreationTokens +=
					data.message.usage.cache_creation_input_tokens ?? 0;
				existing.cacheReadTokens +=
					data.message.usage.cache_read_input_tokens ?? 0;

				// Calculate cost based on mode
				const cost = calculateCostForEntry(data, mode, modelPricing);
				existing.totalCost += cost;

				// Keep track of the latest timestamp
				if (data.timestamp > lastTimestamp) {
					lastTimestamp = data.timestamp;
					existing.lastActivity = formatDate(data.timestamp);
				}

				// Collect version information
				if (data.version) {
					existing.versionSet.add(data.version);
				}

				sessionMap.set(key, existing);
			} catch (e) {
				// Skip invalid JSON lines
			}
		}
	}

	// Convert map to array and filter by date range
	let results = Array.from(sessionMap.values()).map((session) => {
		// Convert Set to sorted array and remove temporary versionSet property
		const { versionSet, ...sessionData } = session;
		return {
			...sessionData,
			versions: Array.from(versionSet).sort(),
		};
	});

	if (options?.since || options?.until) {
		results = results.filter((session) => {
			const dateStr = session.lastActivity.replace(/-/g, ""); // Convert to YYYYMMDD
			if (options.since && dateStr < options.since) return false;
			if (options.until && dateStr > options.until) return false;
			return true;
		});
	}

	// Sort by last activity descending
	return sort(results).desc((item) => new Date(item.lastActivity).getTime());
}

export async function loadMonthlyUsageData(
	options?: LoadOptions,
): Promise<MonthlyUsage[]> {
	const dailyData = await loadDailyUsageData(options);

	const monthlyMap = new Map<string, MonthlyUsage>();

	for (const data of dailyData) {
		// Extract YYYY-MM from YYYY-MM-DD
		const month = data.date.substring(0, 7);

		const existing = monthlyMap.get(month) || {
			month,
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		};

		existing.inputTokens += data.inputTokens;
		existing.outputTokens += data.outputTokens;
		existing.cacheCreationTokens += data.cacheCreationTokens;
		existing.cacheReadTokens += data.cacheReadTokens;
		existing.totalCost += data.totalCost;

		monthlyMap.set(month, existing);
	}

	// Convert to array and sort by month descending
	return Array.from(monthlyMap.values()).sort((a, b) =>
		b.month.localeCompare(a.month),
	);
}
