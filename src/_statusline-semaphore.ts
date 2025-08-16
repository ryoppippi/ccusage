import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import * as limo from '@ryoppippi/limo';
import { z } from 'zod';
import { version } from '../package.json';
import { STATUSLINE_MIN_REFRESH_INTERVAL_MS, STATUSLINE_SEMAPHORE_DIR_NAME } from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Zod schema for statusline semaphore data structure
 */
const statuslineSemaphoreSchema = z.object({
	lastExecutionTime: z.number(), // Unix timestamp in milliseconds
	lastOutput: z.string(), // Cached output from last execution
	sessionId: z.string(), // Session ID for tracking
	pid: z.number().optional(), // Process ID for debugging
	version: z.string().optional(), // Semaphore version for migration
});

/**
 * Type definition for statusline semaphore data structure
 */
type StatuslineSemaphore = z.infer<typeof statuslineSemaphoreSchema>;

/**
 * Gets the semaphore directory path
 */
function getSemaphoreDir(): string {
	return join(tmpdir(), STATUSLINE_SEMAPHORE_DIR_NAME);
}

/**
 * Ensures the semaphore directory exists
 */
function ensureSemaphoreDir(): void {
	const dir = getSemaphoreDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Gets the semaphore file path for a session
 */
function getSemaphoreFilePath(sessionId: string): string {
	return join(getSemaphoreDir(), `${sessionId}.json`);
}

/**
 * Validator for StatuslineSemaphore using Zod
 */
function semaphoreValidator(data: unknown): data is StatuslineSemaphore {
	const result = statuslineSemaphoreSchema.safeParse(data);
	return result.success;
}

/**
 * Checks if we should skip execution based on semaphore
 */
export function checkShouldSkipExecution(
	sessionId: string,
	refreshIntervalMs = STATUSLINE_MIN_REFRESH_INTERVAL_MS,
): Result.Result<{ shouldSkip: boolean; cachedOutput?: string }, Error> {
	return Result.try({
		try: () => {
			ensureSemaphoreDir();
			const filePath = getSemaphoreFilePath(sessionId);

			using semaphore = new limo.Json<StatuslineSemaphore>(filePath, {
				validator: semaphoreValidator,
				allowNoExist: true,
			});

			const data = semaphore.data;
			if (data == null) {
				return { shouldSkip: false };
			}

			const now = Date.now();
			const timeSinceLastExecution = now - data.lastExecutionTime;

			if (timeSinceLastExecution < refreshIntervalMs) {
				logger.debug(`Skipping execution: ${timeSinceLastExecution}ms < ${refreshIntervalMs}ms`);
				return { shouldSkip: true, cachedOutput: data.lastOutput };
			}

			return { shouldSkip: false };
		},
		catch: error => new Error(`Failed to check semaphore: ${String(error)}`),
	})();
}

/**
 * Updates the semaphore with new execution data
 */
export function updateSemaphore(
	sessionId: string,
	output: string,
): Result.Result<void, Error> {
	return Result.try({
		try: () => {
			ensureSemaphoreDir();
			const filePath = getSemaphoreFilePath(sessionId);

			using semaphore = new limo.Json<StatuslineSemaphore>(filePath, {
				validator: semaphoreValidator,
				allowNoExist: true,
			});

			semaphore.data = {
				lastExecutionTime: Date.now(),
				lastOutput: output,
				sessionId,
				pid: process.pid,
				version,
			};

			logger.debug(`Updated semaphore for session: ${sessionId}`);
		},
		catch: error => new Error(`Failed to update semaphore: ${String(error)}`),
	})();
}

/**
 * Cleans up old semaphore files (older than 24 hours)
 * This is a placeholder for future implementation
 */
export function cleanupOldSemaphores(): void {
	// Implementation for cleaning old files
	// This can be called periodically or on startup
	logger.debug('Semaphore cleanup not yet implemented');
}

// In-source testing
if (import.meta.vitest != null) {
	test('should export functions', () => {
		expect(typeof checkShouldSkipExecution).toBe('function');
		expect(typeof updateSemaphore).toBe('function');
		expect(typeof cleanupOldSemaphores).toBe('function');
	});

	test('should skip execution within refresh interval', () => {
		const sessionId = 'test-session-1';

		// First execution - should not skip
		const firstCheck = checkShouldSkipExecution(sessionId, 5000);
		expect(Result.isSuccess(firstCheck)).toBe(true);
		if (Result.isSuccess(firstCheck)) {
			expect(firstCheck.value.shouldSkip).toBe(false);
		}

		// Update semaphore
		const updateResult = updateSemaphore(sessionId, 'test output');
		expect(Result.isSuccess(updateResult)).toBe(true);

		// Immediate second check - should skip
		const secondCheck = checkShouldSkipExecution(sessionId, 5000);
		expect(Result.isSuccess(secondCheck)).toBe(true);
		if (Result.isSuccess(secondCheck)) {
			expect(secondCheck.value.shouldSkip).toBe(true);
			expect(secondCheck.value.cachedOutput).toBe('test output');
		}
	});

	test('should not skip after refresh interval expires', async () => {
		const sessionId = 'test-session-2';
		const refreshInterval = 100; // 100ms for testing

		const updateResult = updateSemaphore(sessionId, 'test output');
		expect(Result.isSuccess(updateResult)).toBe(true);

		// Wait for interval to expire
		await new Promise(resolve => setTimeout(resolve, refreshInterval + 10));

		const check = checkShouldSkipExecution(sessionId, refreshInterval);
		expect(Result.isSuccess(check)).toBe(true);
		if (Result.isSuccess(check)) {
			expect(check.value.shouldSkip).toBe(false);
		}
	});

	test('should handle missing semaphore file gracefully', () => {
		const result = checkShouldSkipExecution('non-existent-session-3', 5000);
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.value.shouldSkip).toBe(false);
		}
	});
}
