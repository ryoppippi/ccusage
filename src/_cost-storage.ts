import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@praha/byethrow';
import { z } from 'zod';
import { DEFAULT_CLAUDE_CONFIG_PATH } from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Schema for a single cost entry
 */
const costEntrySchema = z.object({
	timestamp: z.string(),
	totalCostUsd: z.number(),
	source: z.literal('statusline'),
});

/**
 * Schema for cost data file structure
 */
const costDataSchema = z.object({
	sessionId: z.string(),
	costs: z.array(costEntrySchema),
});

/**
 * Type for a single cost entry
 */
type CostEntry = z.infer<typeof costEntrySchema>;

/**
 * Type for cost data file structure
 */
type CostData = z.infer<typeof costDataSchema>;

/**
 * Get the directory path for storing cost data
 * Uses XDG config directory structure: ~/.config/claude/ccusage/costs/
 * @returns Cost storage directory path
 */
function getCostStorageDir(): string {
	return join(DEFAULT_CLAUDE_CONFIG_PATH, 'ccusage', 'costs');
}

/**
 * Get the file path for a specific session's cost data
 * @param sessionId - Session ID
 * @returns File path for the session's cost data
 */
function getCostFilePath(sessionId: string): string {
	return join(getCostStorageDir(), `${sessionId}.json`);
}

/**
 * Ensure the cost storage directory exists
 * @returns Result indicating success or failure
 */
function ensureCostStorageDir(): Result.Result<void, Error> {
	try {
		const dir = getCostStorageDir();
		mkdirSync(dir, { recursive: true });
		return Result.succeed(undefined);
	}
	catch (error) {
		return Result.fail(error as Error);
	}
}

/**
 * Save cost data for a session
 * Appends new cost entry to existing data or creates new file
 * @param sessionId - Session ID
 * @param totalCostUsd - Total cost in USD from Claude Code
 * @param timestamp - ISO timestamp string (defaults to current time)
 * @returns Result indicating success or failure
 */
export async function saveCostData(
	sessionId: string,
	totalCostUsd: number,
	timestamp?: string,
): Promise<Result.Result<void, Error>> {
	const dirResult = ensureCostStorageDir();
	if (Result.isFailure(dirResult)) {
		return Promise.resolve(dirResult);
	}

	try {
		const filePath = getCostFilePath(sessionId);
		const currentTime = timestamp ?? new Date().toISOString();

		const newEntry: CostEntry = {
			timestamp: currentTime,
			totalCostUsd,
			source: 'statusline',
		};

		// Try to load existing data
		const existingDataResult = await loadCostData(sessionId);

		let costData: CostData;
		if (Result.isSuccess(existingDataResult)) {
			// Append to existing data
			costData = existingDataResult.value;
			costData.costs.push(newEntry);
		}
		else {
			// Create new data
			costData = {
				sessionId,
				costs: [newEntry],
			};
		}

		// Write the updated data
		const jsonContent = JSON.stringify(costData, null, 2);
		await writeFile(filePath, jsonContent, 'utf-8');

		logger.debug(`Saved cost data for session ${sessionId}: $${totalCostUsd}`);
		return Result.succeed(undefined);
	}
	catch (error) {
		return Result.fail(error as Error);
	}
}

/**
 * Load cost data for a session
 * @param sessionId - Session ID
 * @returns Result with cost data or error if not found/invalid
 */
export async function loadCostData(sessionId: string): Promise<Result.Result<CostData, Error>> {
	try {
		const filePath = getCostFilePath(sessionId);
		const content = await readFile(filePath, 'utf-8');
		const parsed = JSON.parse(content) as unknown;
		const result = costDataSchema.safeParse(parsed);

		if (!result.success) {
			return Result.fail(new Error(`Invalid cost data format for session ${sessionId}: ${result.error.message}`));
		}

		return Result.succeed(result.data);
	}
	catch (error) {
		return Result.fail(error as Error);
	}
}

/**
 * Get the most recent cost entry for a session
 * @param sessionId - Session ID
 * @returns Result with the most recent cost entry or error if not found
 */
export async function getLatestCost(sessionId: string): Promise<Result.Result<CostEntry | null, Error>> {
	const loadResult = await loadCostData(sessionId);

	if (Result.isFailure(loadResult)) {
		logger.debug(`Failed to load cost data for session ${sessionId}: ${loadResult.error instanceof Error ? loadResult.error.message : String(loadResult.error)}`);
		return Result.succeed(null); // Return null instead of propagating error
	}

	const data = loadResult.value;
	if (data.costs.length === 0) {
		return Result.succeed(null);
	}

	// Find the entry with the most recent timestamp
	const sortedCosts = data.costs
		.slice()
		.sort((a: CostEntry, b: CostEntry) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	return Result.succeed(sortedCosts[0] ?? null);
}

/**
 * Get saved cost for a session, returning the most recent entry
 * This is a convenience function for use in cost calculation with fallback priority:
 * saved CC costs → pre-calculated costUSD → token-based calculation
 * @param sessionId - Session ID
 * @returns Promise<number | undefined> - Cost value or undefined if not available
 */
export async function getSavedCost(sessionId: string): Promise<number | undefined> {
	const result = await getLatestCost(sessionId);

	if (Result.isSuccess(result) && result.value != null) {
		return result.value.totalCostUsd;
	}

	return undefined;
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('_cost-storage', () => {
		it('should handle non-existent session gracefully', async () => {
			const nonExistentSession = 'non-existent-session';

			// getSavedCost should return undefined for non-existent session
			const savedCost = await getSavedCost(nonExistentSession);
			expect(savedCost).toBeUndefined();

			// loadCostData should return error for non-existent session (file not found)
			const loadResult = await loadCostData(nonExistentSession);
			expect(Result.isFailure(loadResult)).toBe(true);
		});
	});
}
