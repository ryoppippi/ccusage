import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import * as limo from '@ryoppippi/limo';
import { z } from 'zod';
import { version } from '../package.json';
import { DEFAULT_MIN_REFRESH_INTERVAL_MS } from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Zod schema for semaphore data structure
 */
const semaphoreSchema = z.object({
	lastExecutionTime: z.number(), // Unix timestamp in milliseconds
	lastOutput: z.string(), // Cached output from last execution
	sessionId: z.string(), // Session ID for tracking
	pid: z.number().optional(), // Process ID for debugging
	version: z.string().optional(), // Semaphore version for migration
	semaphoreType: z.string(), // Type of semaphore for categorization
});

/**
 * Type definition for semaphore data structure
 */
type SemaphoreData = z.infer<typeof semaphoreSchema>;

/**
 * Configuration for Semaphore instance
 */
export type SemaphoreConfig = {
	semaphoreType: string;
	baseDirName?: string;
	refreshIntervalMs?: number;
};

/**
 * Validator for SemaphoreData using Zod
 */
function semaphoreValidator(data: unknown): data is SemaphoreData {
	const result = semaphoreSchema.safeParse(data);
	return result.success;
}

/**
 * File-based semaphore for rate limiting and caching execution results
 */
export class Semaphore {
	private readonly semaphoreType: string;
	private readonly baseDirName: string;
	private readonly refreshIntervalMs: number;

	constructor(config: SemaphoreConfig) {
		this.semaphoreType = config.semaphoreType;
		this.baseDirName = config.baseDirName ?? `ccusage-${config.semaphoreType}`;
		this.refreshIntervalMs = config.refreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
	}

	/**
	 * Gets the semaphore directory path
	 */
	private getSemaphoreDir(): string {
		return join(tmpdir(), this.baseDirName);
	}

	/**
	 * Ensures the semaphore directory exists
	 */
	private ensureSemaphoreDir(): void {
		const dir = this.getSemaphoreDir();
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Gets the semaphore file path for a session
	 */
	private getSemaphoreFilePath(sessionId: string): string {
		return join(this.getSemaphoreDir(), `${sessionId}.json`);
	}

	/**
	 * Checks if we should skip execution based on semaphore
	 */
	public checkShouldSkip(
		sessionId: string,
		customRefreshIntervalMs?: number,
	): Result.Result<{ shouldSkip: boolean; cachedOutput?: string }, Error> {
		return Result.try({
			try: () => {
				this.ensureSemaphoreDir();
				const filePath = this.getSemaphoreFilePath(sessionId);
				const refreshInterval = customRefreshIntervalMs ?? this.refreshIntervalMs;

				using semaphore = new limo.Json<SemaphoreData>(filePath, {
					validator: semaphoreValidator,
					allowNoExist: true,
				});

				const data = semaphore.data;
				if (data == null) {
					return { shouldSkip: false };
				}

				const now = Date.now();
				const timeSinceLastExecution = now - data.lastExecutionTime;

				if (timeSinceLastExecution < refreshInterval) {
					logger.debug(`Skipping execution: ${timeSinceLastExecution}ms < ${refreshInterval}ms`);
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
	public updateCache(
		sessionId: string,
		output: string,
	): Result.Result<void, Error> {
		return Result.try({
			try: () => {
				this.ensureSemaphoreDir();
				const filePath = this.getSemaphoreFilePath(sessionId);

				using semaphore = new limo.Json<SemaphoreData>(filePath, {
					validator: semaphoreValidator,
					allowNoExist: true,
				});

				semaphore.data = {
					lastExecutionTime: Date.now(),
					lastOutput: output,
					sessionId,
					pid: process.pid,
					version,
					semaphoreType: this.semaphoreType,
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
	public cleanupOldFiles(): void {
		// Implementation for cleaning old files
		// This can be called periodically or on startup
		logger.debug(`Semaphore cleanup not yet implemented for type: ${this.semaphoreType}`);
	}
}

/**
 * Convenience factory functions for common semaphore types
 */
export const SemaphoreFactory = {
	/**
	 * Creates a semaphore instance for statusline command
	 */
	statusline: (refreshIntervalMs?: number): Semaphore => new Semaphore({
		semaphoreType: 'statusline',
		baseDirName: 'ccusage-statusline',
		refreshIntervalMs,
	}),

	/**
	 * Creates a general purpose semaphore instance
	 */
	create: (config: SemaphoreConfig): Semaphore => new Semaphore(config),
} as const;

// In-source testing
if (import.meta.vitest != null) {
	test('should export Semaphore class and factory', () => {
		expect(typeof Semaphore).toBe('function');
		expect(typeof SemaphoreFactory.statusline).toBe('function');
		expect(typeof SemaphoreFactory.create).toBe('function');
	});

	test('should create semaphore instances with factory', () => {
		const statuslineSemaphore = SemaphoreFactory.statusline();
		expect(statuslineSemaphore).toBeInstanceOf(Semaphore);

		const customSemaphore = SemaphoreFactory.create({
			semaphoreType: 'test',
			baseDirName: 'test-semaphore',
			refreshIntervalMs: 1000,
		});
		expect(customSemaphore).toBeInstanceOf(Semaphore);
	});

	test('should skip execution within refresh interval', () => {
		const semaphore = SemaphoreFactory.create({
			semaphoreType: 'test',
			refreshIntervalMs: 5000,
		});
		const sessionId = 'test-session-1';

		// First execution - should not skip
		const firstCheck = semaphore.checkShouldSkip(sessionId);
		expect(Result.isSuccess(firstCheck)).toBe(true);
		if (Result.isSuccess(firstCheck)) {
			expect(firstCheck.value.shouldSkip).toBe(false);
		}

		// Update semaphore
		const updateResult = semaphore.updateCache(sessionId, 'test output');
		expect(Result.isSuccess(updateResult)).toBe(true);

		// Immediate second check - should skip
		const secondCheck = semaphore.checkShouldSkip(sessionId);
		expect(Result.isSuccess(secondCheck)).toBe(true);
		if (Result.isSuccess(secondCheck)) {
			expect(secondCheck.value.shouldSkip).toBe(true);
			expect(secondCheck.value.cachedOutput).toBe('test output');
		}
	});

	test('should not skip after refresh interval expires', async () => {
		const semaphore = SemaphoreFactory.create({
			semaphoreType: 'test',
			refreshIntervalMs: 100,
		});
		const sessionId = 'test-session-2';

		const updateResult = semaphore.updateCache(sessionId, 'test output');
		expect(Result.isSuccess(updateResult)).toBe(true);

		// Wait for interval to expire
		await new Promise(resolve => setTimeout(resolve, 110));

		const check = semaphore.checkShouldSkip(sessionId);
		expect(Result.isSuccess(check)).toBe(true);
		if (Result.isSuccess(check)) {
			expect(check.value.shouldSkip).toBe(false);
		}
	});

	test('should handle missing semaphore file gracefully', () => {
		const semaphore = SemaphoreFactory.create({
			semaphoreType: 'test',
		});
		const result = semaphore.checkShouldSkip('non-existent-session-3');
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.value.shouldSkip).toBe(false);
		}
	});

	test('should use custom refresh interval when provided', () => {
		const semaphore = SemaphoreFactory.create({
			semaphoreType: 'test',
			refreshIntervalMs: 10000, // Long default interval
		});
		const sessionId = 'test-session-4';

		// Update semaphore first
		const updateResult = semaphore.updateCache(sessionId, 'test output');
		expect(Result.isSuccess(updateResult)).toBe(true);

		// Should skip with default interval (10000ms - very long)
		const checkDefault = semaphore.checkShouldSkip(sessionId);
		expect(Result.isSuccess(checkDefault)).toBe(true);
		if (Result.isSuccess(checkDefault)) {
			expect(checkDefault.value.shouldSkip).toBe(true);
		}

		// Should not skip with shorter custom interval (1ms - very short)
		const checkCustom = semaphore.checkShouldSkip(sessionId, 1);
		expect(Result.isSuccess(checkCustom)).toBe(true);
		if (Result.isSuccess(checkCustom)) {
			expect(checkCustom.value.shouldSkip).toBe(false);
		}
	});
}
