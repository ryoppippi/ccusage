/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data
 * from two sources:
 *   1. JSON message files in ~/.local/share/opencode/storage/message/ (pre-Feb 2026)
 *   2. SQLite database at ~/.local/share/opencode/opencode.db (post-Feb 2026 migration)
 *
 * @module data-loader
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { Database } from 'bun:sqlite';
import { isDirectorySync, isFileSync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { logger } from './logger.ts';

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
 * OpenCode SQLite database filename (introduced ~Feb 2026, replacing file-based storage)
 */
const OPENCODE_DB_NAME = 'opencode.db';

/**
 * Environment variable for specifying custom OpenCode data directory
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';

/**
 * User home directory
 */
const USER_HOME_DIR = homedir();

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
 * Get path to the OpenCode SQLite database, or null if it doesn't exist.
 */
function getOpenCodeDbPath(): string | null {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}
	const dbPath = path.join(openCodePath, OPENCODE_DB_NAME);
	return isFileSync(dbPath) ? dbPath : null;
}

/** Row shape returned by the SQLite message query */
type DbMessageRow = {
	id: string;
	session_id: string;
	provider_id: string | null;
	model_id: string | null;
	time_created: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read: number | null;
	cache_write: number | null;
	cost: number | null;
};

/** Row shape returned by the SQLite session query */
type DbSessionRow = {
	id: string;
	parent_id: string | null;
	title: string | null;
	project_id: string | null;
	directory: string | null;
};

/**
 * Load usage entries from the OpenCode SQLite database.
 * Returns an empty array if the DB is absent or unreadable.
 */
async function loadOpenCodeMessagesFromDb(): Promise<Array<LoadedUsageEntry & { id: string }>> {
	const dbPath = getOpenCodeDbPath();
	if (dbPath == null) {
		return [];
	}

	const queryResult = Result.try({
		try: (): DbMessageRow[] => {
			const db = new Database(dbPath, { readonly: true });
			try {
				return db
					.query<DbMessageRow, []>(
						`SELECT
							id,
							session_id,
							json_extract(data, '$.providerID') AS provider_id,
							json_extract(data, '$.modelID')    AS model_id,
							json_extract(data, '$.time.created') AS time_created,
							json_extract(data, '$.tokens.input')       AS input_tokens,
							json_extract(data, '$.tokens.output')      AS output_tokens,
							json_extract(data, '$.tokens.cache.read')  AS cache_read,
							json_extract(data, '$.tokens.cache.write') AS cache_write,
							json_extract(data, '$.cost') AS cost
						FROM message
						WHERE json_extract(data, '$.role') = 'assistant'
						  AND json_extract(data, '$.modelID') IS NOT NULL
						  AND json_extract(data, '$.time.created') IS NOT NULL
						  AND (
						        json_extract(data, '$.tokens.input')  > 0
						     OR json_extract(data, '$.tokens.output') > 0
						  )`,
					)
					.all();
			} finally {
				db.close();
			}
		},
		catch: (error) => error,
	})();

	if (Result.isFailure(queryResult)) {
		logger.warn('Failed to load usage from OpenCode SQLite database', queryResult.error);
		return [];
	}

	return queryResult.value
		.filter((row) => row.provider_id != null && row.model_id != null)
		.map((row) => ({
			id: row.id,
			timestamp: new Date(row.time_created!),
			sessionID: row.session_id,
			usage: {
				inputTokens: row.input_tokens ?? 0,
				outputTokens: row.output_tokens ?? 0,
				cacheCreationInputTokens: row.cache_write ?? 0,
				cacheReadInputTokens: row.cache_read ?? 0,
			},
			model: row.model_id!,
			costUSD: row.cost ?? null,
		}));
}

/**
 * Load session metadata from the OpenCode SQLite database.
 * Returns an empty map if the DB is absent or unreadable.
 */
async function loadOpenCodeSessionsFromDb(): Promise<Map<string, LoadedSessionMetadata>> {
	const dbPath = getOpenCodeDbPath();
	if (dbPath == null) {
		return new Map();
	}

	const queryResult = Result.try({
		try: (): DbSessionRow[] => {
			const db = new Database(dbPath, { readonly: true });
			try {
				return db
					.query<DbSessionRow, []>(
						`SELECT id, parent_id, title, project_id, directory FROM session`,
					)
					.all();
			} finally {
				db.close();
			}
		},
		catch: (error) => error,
	})();

	if (Result.isFailure(queryResult)) {
		logger.warn('Failed to load sessions from OpenCode SQLite database', queryResult.error);
		return new Map();
	}

	const sessionMap = new Map<string, LoadedSessionMetadata>();
	for (const row of queryResult.value) {
		sessionMap.set(row.id, {
			id: row.id,
			parentID: row.parent_id ?? null,
			title: row.title ?? row.id,
			projectID: row.project_id ?? 'unknown',
			directory: row.directory ?? 'unknown',
		});
	}
	return sessionMap;
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

	const [fileSessionMap, dbSessionMap] = await Promise.all([
		// File-based sessions (pre-Feb 2026)
		(async () => {
			if (openCodePath == null) {
				return new Map<string, LoadedSessionMetadata>();
			}
			const sessionsDir = path.join(
				openCodePath,
				OPENCODE_STORAGE_DIR_NAME,
				OPENCODE_SESSIONS_DIR_NAME,
			);
			if (!isDirectorySync(sessionsDir)) {
				return new Map<string, LoadedSessionMetadata>();
			}

			const sessionFiles = await glob('**/*.json', { cwd: sessionsDir, absolute: true });
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
		})(),
		// SQLite-based sessions (post-Feb 2026 migration)
		loadOpenCodeSessionsFromDb(),
	]);

	// Merge: DB entries take precedence for any ID that appears in both
	return new Map([...fileSessionMap, ...dbSessionMap]);
}

/**
 * Load all OpenCode messages from both file-based storage and SQLite database.
 * @returns Array of LoadedUsageEntry for aggregation
 */
export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();

	const [fileEntries, dbEntries] = await Promise.all([
		// File-based messages (pre-Feb 2026)
		(async () => {
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

			const messageFiles = await glob('**/*.json', { cwd: messagesDir, absolute: true });
			const entries: Array<LoadedUsageEntry & { id: string }> = [];

			for (const filePath of messageFiles) {
				const message = await loadOpenCodeMessage(filePath);
				if (message == null) {
					continue;
				}
				if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
					continue;
				}
				if (message.providerID == null || message.modelID == null) {
					continue;
				}
				entries.push({ id: message.id, ...convertOpenCodeMessageToUsageEntry(message) });
			}
			return entries;
		})(),
		// SQLite-based messages (post-Feb 2026 migration)
		loadOpenCodeMessagesFromDb(),
	]);

	// Deduplicate by message ID — DB entries take precedence over file entries
	const dedupeSet = new Set<string>();
	const result: LoadedUsageEntry[] = [];

	for (const { id, ...usageEntry } of [...dbEntries, ...fileEntries]) {
		if (dedupeSet.has(id)) {
			continue;
		}
		dedupeSet.add(id);
		result.push(usageEntry);
	}

	return result;
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
