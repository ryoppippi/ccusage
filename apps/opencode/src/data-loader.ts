/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data
 * from JSON message files stored in OpenCode data directories.
 * OpenCode stores usage data in ~/.local/share/opencode/storage/message/
 *
 * @module data-loader
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';

/**
 * Default OpenCode data directory path (~/.local/share/opencode)
 */
const DEFAULT_OPENCODE_PATH = '.local/share/opencode';

/**
 * OpenCode storage subdirectory containing message data
 */
const OPENCODE_STORAGE_DIR_NAME = 'storage';

/**
 * OpenCode messages subdirectory within storage
 */
const OPENCODE_MESSAGES_DIR_NAME = 'message';
const OPENCODE_SESSIONS_DIR_NAME = 'session';

/**
 * Environment variable for specifying custom OpenCode data directory
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';

/**
 * User home directory
 */
const USER_HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();

/**
 * Branded Valibot schema for model names
 */
const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);

/**
 * Branded Valibot schema for session IDs
 */
const sessionIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Session ID cannot be empty'),
	v.brand('SessionId'),
);

/**
 * OpenCode message token structure
 */
export const openCodeTokensSchema = v.object({
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	reasoning: v.optional(v.number()),
	cache: v.optional(
		v.object({
			read: v.optional(v.number()),
			write: v.optional(v.number()),
		}),
	),
});

/**
 * OpenCode message data structure
 */
export const openCodeMessageSchema = v.object({
	id: v.string(),
	sessionID: v.optional(sessionIdSchema),
	providerID: v.optional(v.string()),
	modelID: v.optional(modelNameSchema),
	time: v.object({
		created: v.optional(v.number()),
		completed: v.optional(v.number()),
	}),
	tokens: v.optional(openCodeTokensSchema),
	cost: v.optional(v.number()),
});

export const openCodeSessionSchema = v.object({
	id: sessionIdSchema,
	parentID: v.optional(v.nullable(sessionIdSchema)),
	title: v.optional(v.string()),
	projectID: v.optional(v.string()),
	directory: v.optional(v.string()),
});

/**
 * Represents a single usage data entry loaded from OpenCode files
 */
export type LoadedUsageEntry = {
	timestamp: Date;
	sessionID: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	model: string;
	costUSD: number | null;
};

export type LoadedSessionMetadata = {
	id: string;
	parentID: string | null;
	title: string;
	projectID: string;
	directory: string;
};

export type OpenCodeMessageLoadOptions = {
	since?: string; // YYYY-MM-DD or YYYYMMDD
	until?: string; // YYYY-MM-DD or YYYYMMDD
};

function normalizeDateInput(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed === '') {
		return undefined;
	}

	const compact = trimmed.replace(/-/g, '');
	if (!/^\d{8}$/.test(compact)) {
		throw new Error(`Invalid date filter: "${value}"`);
	}
	return compact;
}

function getDateKeyFromTimestamp(timestampMs: number): string {
	return new Date(timestampMs).toISOString().slice(0, 10).replace(/-/g, '');
}

function isWithinRange(dateKey: string, since?: string, until?: string): boolean {
	if (since != null && dateKey < since) {
		return false;
	}
	if (until != null && dateKey > until) {
		return false;
	}
	return true;
}

/**
 * Get OpenCode data directory
 * @returns Path to OpenCode data directory, or null if not found
 */
export function getOpenCodePath(): string | null {
	// Check environment variable first
	const envPath = process.env[OPENCODE_CONFIG_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			return normalizedPath;
		}
	}

	// Use default path
	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_OPENCODE_PATH);
	if (isDirectorySync(defaultPath)) {
		return defaultPath;
	}

	return null;
}

/**
 * Load OpenCode message from JSON file
 * @param filePath - Path to message JSON file
 * @returns Parsed message data or null on failure
 */
async function loadOpenCodeMessage(
	filePath: string,
): Promise<v.InferOutput<typeof openCodeMessageSchema> | null> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const data: unknown = JSON.parse(content);
		return v.parse(openCodeMessageSchema, data);
	} catch {
		return null;
	}
}

/**
 * Convert OpenCode message to LoadedUsageEntry
 * @param message - Parsed OpenCode message
 * @returns LoadedUsageEntry suitable for aggregation
 */
function convertOpenCodeMessageToUsageEntry(
	message: v.InferOutput<typeof openCodeMessageSchema>,
): LoadedUsageEntry {
	const createdMs = message.time.created ?? Date.now();

	return {
		timestamp: new Date(createdMs),
		sessionID: message.sessionID ?? 'unknown',
		usage: {
			inputTokens: message.tokens?.input ?? 0,
			outputTokens: message.tokens?.output ?? 0,
			cacheCreationInputTokens: message.tokens?.cache?.write ?? 0,
			cacheReadInputTokens: message.tokens?.cache?.read ?? 0,
		},
		model: message.modelID ?? 'unknown',
		costUSD: message.cost ?? null,
	};
}

async function loadOpenCodeSession(
	filePath: string,
): Promise<v.InferOutput<typeof openCodeSessionSchema> | null> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const data: unknown = JSON.parse(content);
		return v.parse(openCodeSessionSchema, data);
	} catch {
		return null;
	}
}

function convertOpenCodeSessionToMetadata(
	session: v.InferOutput<typeof openCodeSessionSchema>,
): LoadedSessionMetadata {
	return {
		id: session.id,
		parentID: session.parentID ?? null,
		title: session.title ?? session.id,
		projectID: session.projectID ?? 'unknown',
		directory: session.directory ?? 'unknown',
	};
}

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return new Map();
	}

	const sessionsDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_SESSIONS_DIR_NAME,
	);

	if (!isDirectorySync(sessionsDir)) {
		return new Map();
	}

	const sessionFiles = await glob('**/*.json', {
		cwd: sessionsDir,
		absolute: true,
	});

	const sessionMap = new Map<string, LoadedSessionMetadata>();

	for (const filePath of sessionFiles) {
		const session = await loadOpenCodeSession(filePath);

		if (session == null) {
			continue;
		}

		const metadata = convertOpenCodeSessionToMetadata(session);
		sessionMap.set(metadata.id, metadata);
	}

	return sessionMap;
}

/**
 * Load all OpenCode messages
 * @returns Array of LoadedUsageEntry for aggregation
 */
export async function loadOpenCodeMessages(
	options: OpenCodeMessageLoadOptions = {},
): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);

	if (!isDirectorySync(messagesDir)) {
		return [];
	}

	let messageFiles: string[] = [];

	const entries: LoadedUsageEntry[] = [];
	const since = normalizeDateInput(options.since);
	const until = normalizeDateInput(options.until);
	const hasDateFilter = since != null || until != null;
	const dedupeSet = new Set<string>();

	if (hasDateFilter) {
		const sessionEntries = await readdir(messagesDir, { withFileTypes: true }).catch(() => []);
		const sessionDirs = sessionEntries
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(messagesDir, entry.name));

		for (const sessionDir of sessionDirs) {
			if (since != null) {
				try {
					const dirStat = await stat(sessionDir);
					const dirDateKey = getDateKeyFromTimestamp(dirStat.mtimeMs);
					if (dirDateKey < since) {
						continue;
					}
				} catch {
					// Continue to scan the session directory when stat fails.
				}
			}

			const sessionFiles = await glob('**/*.json', {
				cwd: sessionDir,
				absolute: true,
			}).catch(() => []);
			messageFiles.push(...sessionFiles);
		}
	} else {
		// Find all message JSON files
		messageFiles = await glob('**/*.json', {
			cwd: messagesDir,
			absolute: true,
		});
	}

	for (const filePath of messageFiles) {
		let fileModifiedMs: number | null = null;
		if (hasDateFilter) {
			try {
				const fileStat = await stat(filePath);
				fileModifiedMs = fileStat.mtimeMs;
				const fileDateKey = getDateKeyFromTimestamp(fileModifiedMs);
				if (!isWithinRange(fileDateKey, since, until)) {
					continue;
				}
			} catch {
				// Fall back to reading file contents when stat fails.
			}
		}

		const message = await loadOpenCodeMessage(filePath);

		if (message == null) {
			continue;
		}

		if (hasDateFilter) {
			const createdMs = message.time.created ?? fileModifiedMs;
			if (createdMs == null) {
				continue;
			}
			const dateKey = getDateKeyFromTimestamp(createdMs);
			if (!isWithinRange(dateKey, since, until)) {
				continue;
			}
		}

		// Skip messages with no tokens
		if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
			continue;
		}

		// Skip if no provider or model
		if (message.providerID == null || message.modelID == null) {
			continue;
		}

		// Deduplicate by message ID
		const dedupeKey = `${message.id}`;
		if (dedupeSet.has(dedupeKey)) {
			continue;
		}
		dedupeSet.add(dedupeKey);

		const entry = convertOpenCodeMessageToUsageEntry(message);
		entries.push(entry);
	}

	return entries;
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('data-loader', () => {
		it('should convert OpenCode message to LoadedUsageEntry', () => {
			const message = {
				id: 'msg_123',
				sessionID: 'ses_456' as v.InferOutput<typeof sessionIdSchema>,
				providerID: 'anthropic',
				modelID: 'claude-sonnet-4-5' as v.InferOutput<typeof modelNameSchema>,
				time: {
					created: 1700000000000,
					completed: 1700000010000,
				},
				tokens: {
					input: 100,
					output: 200,
					reasoning: 0,
					cache: {
						read: 50,
						write: 25,
					},
				},
				cost: 0.001,
			};

			const entry = convertOpenCodeMessageToUsageEntry(message);

			expect(entry.sessionID).toBe('ses_456');
			expect(entry.usage.inputTokens).toBe(100);
			expect(entry.usage.outputTokens).toBe(200);
			expect(entry.usage.cacheReadInputTokens).toBe(50);
			expect(entry.usage.cacheCreationInputTokens).toBe(25);
			expect(entry.model).toBe('claude-sonnet-4-5');
		});

		it('should handle missing optional fields', () => {
			const message = {
				id: 'msg_123',
				providerID: 'openai',
				modelID: 'gpt-5.1' as v.InferOutput<typeof modelNameSchema>,
				time: {
					created: 1700000000000,
				},
				tokens: {
					input: 50,
					output: 100,
				},
			};

			const entry = convertOpenCodeMessageToUsageEntry(message);

			expect(entry.usage.inputTokens).toBe(50);
			expect(entry.usage.outputTokens).toBe(100);
			expect(entry.usage.cacheReadInputTokens).toBe(0);
			expect(entry.usage.cacheCreationInputTokens).toBe(0);
			expect(entry.costUSD).toBe(null);
		});
	});
}
