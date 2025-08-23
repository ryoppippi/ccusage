/**
 * @fileoverview Utility functions for data processing and file operations
 *
 * This module contains utility functions for formatting dates, processing files,
 * calculating costs, and other data manipulation operations.
 *
 * @module _data-utils
 */

import type { GlobResult, UsageData } from './_data-schemas.ts';
import type { CostMode, SortOrder } from './_types.ts';
import type { PricingFetcher } from './pricing-fetcher.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { unreachable } from '@core/errorutil';
import { Result } from '@praha/byethrow';
import { sort } from 'fast-sort';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import { CLAUDE_CONFIG_DIR_ENV, CLAUDE_PROJECTS_DIR_NAME, DEFAULT_CLAUDE_CODE_PATH, DEFAULT_CLAUDE_CONFIG_PATH, USAGE_DATA_GLOB_PATTERN, USER_HOME_DIR } from './_consts.ts';
import {
	dailyDateSchema,
} from './_types.ts';
import { logger } from './logger.ts';

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
			`No valid Claude data directories found in CLAUDE_CONFIG_DIR. Please ensure the following exists:\n- ${envPaths}/${CLAUDE_PROJECTS_DIR_NAME}`.trim(),
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
			`No valid Claude data directories found. Please ensure at least one of the following exists:\n- ${path.join(DEFAULT_CLAUDE_CONFIG_PATH, CLAUDE_PROJECTS_DIR_NAME)}\n- ${path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH, CLAUDE_PROJECTS_DIR_NAME)}\n- Or set ${CLAUDE_CONFIG_DIR_ENV} environment variable to valid directory path(s) containing a '${CLAUDE_PROJECTS_DIR_NAME}' subdirectory`.trim(),
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
 * Creates a date formatter with the specified timezone and locale
 * @param timezone - Timezone to use (e.g., 'UTC', 'America/New_York')
 * @param locale - Locale to use for formatting (e.g., 'en-US', 'ja-JP')
 * @returns Intl.DateTimeFormat instance
 */
function createDateFormatter(timezone: string | undefined, locale: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
}

/**
 * Creates a date parts formatter with the specified timezone and locale
 * @param timezone - Timezone to use
 * @param locale - Locale to use for formatting
 * @returns Intl.DateTimeFormat instance
 */
function createDatePartsFormatter(timezone: string | undefined, locale: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
}

/**
 * Formats a date string to YYYY-MM-DD format
 * @param dateStr - Input date string
 * @param timezone - Optional timezone to use for formatting
 * @param locale - Optional locale to use for formatting (defaults to 'en-CA' for YYYY-MM-DD format)
 * @returns Formatted date string in YYYY-MM-DD format
 */
export function formatDate(dateStr: string, timezone?: string, locale?: string): string {
	const date = new Date(dateStr);
	// Use en-CA as default for consistent YYYY-MM-DD format
	const formatter = createDateFormatter(timezone, locale ?? 'en-CA');
	return formatter.format(date);
}

/**
 * Formats a date string to compact format with year on first line and month-day on second
 * @param dateStr - Input date string
 * @param timezone - Timezone to use for formatting (pass undefined to use system timezone)
 * @param locale - Locale to use for formatting
 * @returns Formatted date string with newline separator (YYYY\nMM-DD)
 */
export function formatDateCompact(dateStr: string, timezone: string | undefined, locale: string): string {
	// For YYYY-MM-DD format, append T00:00:00 to parse as local date
	// Without this, new Date('YYYY-MM-DD') interprets as UTC midnight
	const parseResult = dailyDateSchema.safeParse(dateStr);
	const date = parseResult.success
		? timezone != null
			? new Date(`${dateStr}T00:00:00Z`)
			: new Date(`${dateStr}T00:00:00`)
		: new Date(dateStr);
	const formatter = createDatePartsFormatter(timezone, locale);
	const parts = formatter.formatToParts(date);
	const year = parts.find(p => p.type === 'year')?.value ?? '';
	const month = parts.find(p => p.type === 'month')?.value ?? '';
	const day = parts.find(p => p.type === 'day')?.value ?? '';
	return `${year}\n${month}-${day}`;
}

/**
 * Generic function to sort items by date based on sort order
 * @param items - Array of items to sort
 * @param getDate - Function to extract date/timestamp from item
 * @param order - Sort order (asc or desc)
 * @returns Sorted array
 */
export function sortByDate<T>(
	items: T[],
	getDate: (item: T) => string | Date,
	order: SortOrder = 'desc',
): T[] {
	const sorted = sort(items);
	switch (order) {
		case 'desc':
			return sorted.desc(item => new Date(getDate(item)).getTime());
		case 'asc':
			return sorted.asc(item => new Date(getDate(item)).getTime());
		default:
			unreachable(order);
	}
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
