/**
 * @fileoverview Data loading utilities for Amp CLI usage analysis
 *
 * This module provides functions for loading and parsing Amp usage data
 * from JSON thread files stored in Amp data directories.
 * Amp stores usage data in ~/.local/share/amp/threads/
 *
 * @module data-loader
 */

import type { TokenUsageEvent } from './_types.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	AMP_DATA_DIR_ENV,
	AMP_THREAD_GLOB,
	AMP_THREADS_DIR_NAME,
	DEFAULT_AMP_DIR,
} from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Amp usageLedger event schema
 */
const usageLedgerEventSchema = v.object({
	id: v.string(),
	timestamp: v.string(),
	model: v.string(),
	credits: v.number(),
	tokens: v.object({
		input: v.optional(v.number()),
		output: v.optional(v.number()),
	}),
	operationType: v.optional(v.string()),
	fromMessageId: v.optional(v.number()),
	toMessageId: v.optional(v.number()),
});

/**
 * Amp message usage schema (for cache tokens)
 */
const messageUsageSchema = v.object({
	model: v.optional(v.string()),
	inputTokens: v.optional(v.number()),
	outputTokens: v.optional(v.number()),
	cacheCreationInputTokens: v.optional(v.number()),
	cacheReadInputTokens: v.optional(v.number()),
	totalInputTokens: v.optional(v.number()),
	credits: v.optional(v.number()),
});

/**
 * Amp message schema
 */
const messageSchema = v.object({
	role: v.string(),
	messageId: v.number(),
	usage: v.optional(messageUsageSchema),
});

/**
 * Amp thread file schema
 */
const threadSchema = v.object({
	id: v.string(),
	created: v.optional(v.number()),
	title: v.optional(v.string()),
	messages: v.optional(v.array(messageSchema)),
	usageLedger: v.optional(
		v.object({
			events: v.optional(v.array(usageLedgerEventSchema)),
		}),
	),
});

type ParsedThread = v.InferOutput<typeof threadSchema>;
type ParsedUsageLedgerEvent = v.InferOutput<typeof usageLedgerEventSchema>;
type ParsedMessage = v.InferOutput<typeof messageSchema>;

/**
 * Get Amp data directory
 * @returns Path to Amp data directory, or null if not found
 */
export function getAmpPath(): string | null {
	// Check environment variable first
	const envPath = process.env[AMP_DATA_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			return normalizedPath;
		}
	}

	// Use default path
	if (isDirectorySync(DEFAULT_AMP_DIR)) {
		return DEFAULT_AMP_DIR;
	}

	return null;
}

/**
 * Find cache token information from messages for a specific messageId range
 */
function findCacheTokensForEvent(
	messages: ParsedMessage[] | undefined,
	fromMessageId: number | undefined,
	toMessageId: number | undefined,
): { cacheCreationInputTokens: number; cacheReadInputTokens: number } {
	if (messages == null || toMessageId == null) {
		return { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	}

	// Find the assistant message that corresponds to this event
	const message = messages.find((m) => m.role === 'assistant' && m.messageId === toMessageId);

	if (message?.usage == null) {
		return { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
	}

	return {
		cacheCreationInputTokens: message.usage.cacheCreationInputTokens ?? 0,
		cacheReadInputTokens: message.usage.cacheReadInputTokens ?? 0,
	};
}

/**
 * Convert usageLedger event to TokenUsageEvent
 */
function convertLedgerEventToUsageEvent(
	threadId: string,
	event: ParsedUsageLedgerEvent,
	messages: ParsedMessage[] | undefined,
): TokenUsageEvent {
	const inputTokens = event.tokens.input ?? 0;
	const outputTokens = event.tokens.output ?? 0;

	const { cacheCreationInputTokens, cacheReadInputTokens } = findCacheTokensForEvent(
		messages,
		event.fromMessageId,
		event.toMessageId,
	);

	return {
		timestamp: event.timestamp,
		threadId,
		model: event.model,
		credits: event.credits,
		operationType: event.operationType ?? 'unknown',
		inputTokens,
		outputTokens,
		cacheCreationInputTokens,
		cacheReadInputTokens,
		totalTokens: inputTokens + outputTokens,
	};
}

/**
 * Load and parse a single Amp thread file
 */
async function loadThreadFile(filePath: string): Promise<ParsedThread | null> {
	const readResult = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => error,
	});

	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read Amp thread file', { filePath, error: readResult.error });
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => error,
	})();

	if (Result.isFailure(parseResult)) {
		logger.debug('Failed to parse Amp thread JSON', { filePath, error: parseResult.error });
		return null;
	}

	const validationResult = v.safeParse(threadSchema, parseResult.value);
	if (!validationResult.success) {
		logger.debug('Failed to validate Amp thread schema', {
			filePath,
			issues: validationResult.issues,
		});
		return null;
	}

	return validationResult.output;
}

export type LoadOptions = {
	threadDirs?: string[];
};

export type LoadResult = {
	events: TokenUsageEvent[];
	threads: Map<string, { title: string; created: number | undefined }>;
	missingDirectories: string[];
};

/**
 * Load all Amp usage events from thread files
 */
export async function loadAmpUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const ampPath = getAmpPath();
	const providedDirs =
		options.threadDirs != null && options.threadDirs.length > 0
			? options.threadDirs.map((dir) => path.resolve(dir))
			: undefined;

	const defaultThreadsDir = ampPath != null ? path.join(ampPath, AMP_THREADS_DIR_NAME) : null;

	const threadDirs = providedDirs ?? (defaultThreadsDir != null ? [defaultThreadsDir] : []);

	const events: TokenUsageEvent[] = [];
	const threads = new Map<string, { title: string; created: number | undefined }>();
	const missingDirectories: string[] = [];

	for (const dir of threadDirs) {
		if (!isDirectorySync(dir)) {
			missingDirectories.push(dir);
			continue;
		}

		const files = await glob(AMP_THREAD_GLOB, {
			cwd: dir,
			absolute: true,
		});

		for (const file of files) {
			const thread = await loadThreadFile(file);
			if (thread == null) {
				continue;
			}

			const threadId = thread.id;
			threads.set(threadId, {
				title: thread.title ?? 'Untitled',
				created: thread.created,
			});

			const ledgerEvents = thread.usageLedger?.events ?? [];
			for (const ledgerEvent of ledgerEvents) {
				const event = convertLedgerEventToUsageEvent(threadId, ledgerEvent, thread.messages);
				events.push(event);
			}
		}
	}

	// Sort events by timestamp
	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, threads, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadAmpUsageEvents', () => {
		it('parses Amp thread files and extracts usage events', async () => {
			const threadData = {
				v: 195,
				id: 'T-test-thread-123',
				created: 1700000000000,
				title: 'Test Thread',
				messages: [
					{
						role: 'user',
						messageId: 0,
						content: [{ type: 'text', text: 'hi' }],
					},
					{
						role: 'assistant',
						messageId: 1,
						content: [{ type: 'text', text: 'Hello!' }],
						usage: {
							model: 'claude-haiku-4-5-20251001',
							inputTokens: 100,
							outputTokens: 50,
							cacheCreationInputTokens: 500,
							cacheReadInputTokens: 200,
							totalInputTokens: 800,
							credits: 1.5,
						},
					},
				],
				usageLedger: {
					events: [
						{
							id: 'event-1',
							timestamp: '2025-11-23T10:00:00.000Z',
							model: 'claude-haiku-4-5-20251001',
							credits: 1.5,
							tokens: {
								input: 100,
								output: 50,
							},
							operationType: 'inference',
							fromMessageId: 0,
							toMessageId: 1,
						},
					],
				},
			};

			await using fixture = await createFixture({
				threads: {
					'T-test-thread-123.json': JSON.stringify(threadData),
				},
			});

			const { events, threads, missingDirectories } = await loadAmpUsageEvents({
				threadDirs: [fixture.getPath('threads')],
			});

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(1);

			const event = events[0]!;
			expect(event.threadId).toBe('T-test-thread-123');
			expect(event.model).toBe('claude-haiku-4-5-20251001');
			expect(event.inputTokens).toBe(100);
			expect(event.outputTokens).toBe(50);
			expect(event.cacheCreationInputTokens).toBe(500);
			expect(event.cacheReadInputTokens).toBe(200);
			expect(event.credits).toBe(1.5);

			expect(threads.get('T-test-thread-123')).toEqual({
				title: 'Test Thread',
				created: 1700000000000,
			});
		});

		it('handles missing directories gracefully', async () => {
			const { events, missingDirectories } = await loadAmpUsageEvents({
				threadDirs: ['/nonexistent/path'],
			});

			expect(events).toEqual([]);
			expect(missingDirectories).toContain('/nonexistent/path');
		});

		it('handles malformed JSON gracefully', async () => {
			await using fixture = await createFixture({
				threads: {
					'invalid.json': 'not valid json',
				},
			});

			const { events } = await loadAmpUsageEvents({
				threadDirs: [fixture.getPath('threads')],
			});

			expect(events).toEqual([]);
		});
	});
}
