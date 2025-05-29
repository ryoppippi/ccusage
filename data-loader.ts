import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";

export interface UsageData {
	timestamp: string;
	message: {
		usage: {
			input_tokens: number;
			output_tokens: number;
		};
	};
	costUSD: number;
}

export interface DailyUsage {
	date: string;
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
}

export interface SessionUsage {
	sessionId: string;
	projectPath: string;
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
	lastActivity: string;
}

export const formatDate = (dateStr: string): string => {
	const date = new Date(dateStr);
	const offsetDate = new Date(date.getTime() + 9 * 60 * 60 * 1000); // UTC+9 for JST
	const year = offsetDate.getUTCFullYear();
	const month = String(offsetDate.getUTCMonth() + 1).padStart(2, "0");
	const day = String(offsetDate.getUTCDate()).padStart(2, "0");
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
	const claudeDir = options?.claudePath
		? path.join(options.claudePath, "projects")
		: path.join(homedir(), ".claude", "projects");
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
				const data = JSON.parse(line) as UsageData;
				if (!data.timestamp || !data.message?.usage) {
					continue;
				}

				const date = formatDate(data.timestamp);
				const existing = dailyMap.get(date) || {
					date,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
				};

				existing.inputTokens += data.message.usage.input_tokens || 0;
				existing.outputTokens += data.message.usage.output_tokens || 0;
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
	return results.sort((a, b) => {
		const dateA = new Date(a.date);
		const dateB = new Date(b.date);
		return dateB.getTime() - dateA.getTime();
	});
}

export async function loadSessionData(
	options?: LoadOptions,
): Promise<SessionUsage[]> {
	const claudeDir = options?.claudePath
		? path.join(options.claudePath, "projects")
		: path.join(homedir(), ".claude", "projects");
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
				const data = JSON.parse(line) as UsageData;
				if (!data.timestamp || !data.message?.usage) {
					continue;
				}

				const key = `${projectPath}/${sessionId}`;
				const existing = sessionMap.get(key) || {
					sessionId: sessionId || "unknown",
					projectPath: projectPath || "Unknown Project",
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					lastActivity: "",
				};

				existing.inputTokens += data.message.usage.input_tokens || 0;
				existing.outputTokens += data.message.usage.output_tokens || 0;
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
	return results.sort((a, b) => {
		return b.totalCost - a.totalCost;
	});
}
