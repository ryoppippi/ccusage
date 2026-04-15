/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data
 * from JSON message files or a SQLite database stored in OpenCode data directories.
 * OpenCode stores usage data in ~/.local/share/opencode/opencode.db (newer versions)
 * or ~/.local/share/opencode/storage/message/ (older versions).
 *
 * @module data-loader
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
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

type DbMessageRow = {
	id: string;
	session_id: string;
	time_created: number;
	data: string;
};

type DbSessionRow = {
	id: string;
	project_id: string;
	parent_id: string | null;
	title: string;
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

/**
 * Get path to OpenCode SQLite database, or null if it doesn't exist
 */
function getOpenCodeDbPath(): string | null {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}
	const dbPath = path.join(openCodePath, 'opencode.db');
	return existsSync(dbPath) ? dbPath : null;
}

/**
 * Load usage entries from OpenCode SQLite database
 */
function loadOpenCodeMessagesFromDb(dbPath: string): LoadedUsageEntry[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const stmt = db.prepare(`
			SELECT id, session_id, time_created, data
			FROM message
			WHERE json_extract(data, '$.tokens') IS NOT NULL
			  AND json_extract(data, '$.modelID') IS NOT NULL
			  AND json_extract(data, '$.providerID') IS NOT NULL
		`);
		const rows = stmt.all() as DbMessageRow[];
		const entries: LoadedUsageEntry[] = [];
		const dedupeSet = new Set<string>();

		for (const row of rows) {
			if (dedupeSet.has(row.id)) {
				continue;
			}
			dedupeSet.add(row.id);

			let parsedData: unknown;
			try {
				parsedData = JSON.parse(row.data);
			} catch {
				continue;
			}

			const merged =
				typeof parsedData === 'object' && parsedData !== null
					? { id: row.id, sessionID: row.session_id, ...parsedData }
					: { id: row.id, sessionID: row.session_id };

			const result = v.safeParse(openCodeMessageSchema, merged);
			if (!result.success) {
				continue;
			}

			const message = result.output;
			if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
				continue;
			}

			entries.push(convertOpenCodeMessageToUsageEntry(message));
		}

		return entries;
	} finally {
		db.close();
	}
}

/**
 * Load session metadata from OpenCode SQLite database
 */
function loadOpenCodeSessionsFromDb(dbPath: string): Map<string, LoadedSessionMetadata> {
	const db = new Database(dbPath, { readonly: true });
	try {
		const stmt = db.prepare('SELECT id, project_id, parent_id, title, directory FROM session');
		const rows = stmt.all() as DbSessionRow[];
		const sessionMap = new Map<string, LoadedSessionMetadata>();

		for (const row of rows) {
			const result = v.safeParse(openCodeSessionSchema, {
				id: row.id,
				parentID: row.parent_id ?? null,
				title: row.title,
				projectID: row.project_id,
				directory: row.directory,
			});
			if (!result.success) {
				continue;
			}
			const metadata = convertOpenCodeSessionToMetadata(result.output);
			sessionMap.set(metadata.id, metadata);
		}

		return sessionMap;
	} finally {
		db.close();
	}
}

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const dbPath = getOpenCodeDbPath();
	if (dbPath != null) {
		return loadOpenCodeSessionsFromDb(dbPath);
	}

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
export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const dbPath = getOpenCodeDbPath();
	if (dbPath != null) {
		return loadOpenCodeMessagesFromDb(dbPath);
	}

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

	// Find all message JSON files
	const messageFiles = await glob('**/*.json', {
		cwd: messagesDir,
		absolute: true,
	});

	const entries: LoadedUsageEntry[] = [];
	const dedupeSet = new Set<string>();

	for (const filePath of messageFiles) {
		const message = await loadOpenCodeMessage(filePath);

		if (message == null) {
			continue;
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
	const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;

	describe('convertOpenCodeMessageToUsageEntry', () => {
		it('should convert OpenCode message to LoadedUsageEntry', () => {
			const message = {
				id: 'msg_123',
				sessionID: 'ses_456' as v.InferOutput<typeof sessionIdSchema>,
				providerID: 'anthropic',
				modelID: 'claude-sonnet-4-20250514' as v.InferOutput<typeof modelNameSchema>,
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
			expect(entry.model).toBe('claude-sonnet-4-20250514');
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

	describe('loadOpenCodeMessages (SQLite)', () => {
		let testDir: string;
		let origEnv: string | undefined;

		const createTestDb = (dbPath: string) => {
			const db = new Database(dbPath);
			db.exec(`
				CREATE TABLE message (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					time_created INTEGER NOT NULL,
					time_updated INTEGER NOT NULL,
					data TEXT NOT NULL
				)
			`);
			db.exec(`
				CREATE TABLE session (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					parent_id TEXT,
					slug TEXT NOT NULL,
					directory TEXT NOT NULL,
					title TEXT NOT NULL
				)
			`);
			return db;
		};

		beforeEach(() => {
			testDir = path.join(tmpdir(), `opencode-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			origEnv = process.env[OPENCODE_CONFIG_DIR_ENV];
			process.env[OPENCODE_CONFIG_DIR_ENV] = testDir;
		});

		afterEach(() => {
			if (origEnv === undefined) {
				delete process.env[OPENCODE_CONFIG_DIR_ENV];
			} else {
				process.env[OPENCODE_CONFIG_DIR_ENV] = origEnv;
			}
			rmSync(testDir, { recursive: true, force: true });
		});

		it('should load messages from SQLite database', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
			db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
				'msg_001',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					time: { created: 1700000000000, completed: 1700000010000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 100, output: 200, cache: { read: 50, write: 25 } },
					cost: 0.001,
				}),
			);
			db.close();

			const entries = await loadOpenCodeMessages();

			expect(entries).toHaveLength(1);
			expect(entries[0]?.sessionID).toBe('ses_001');
			expect(entries[0]?.usage.inputTokens).toBe(100);
			expect(entries[0]?.usage.outputTokens).toBe(200);
			expect(entries[0]?.usage.cacheReadInputTokens).toBe(50);
			expect(entries[0]?.usage.cacheCreationInputTokens).toBe(25);
			expect(entries[0]?.costUSD).toBe(0.001);
			expect(entries[0]?.model).toBe('claude-sonnet-4-20250514');
			expect(entries[0]?.timestamp).toEqual(new Date(1700000000000));
		});

		it('should skip messages with no tokens', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
			const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
			insert.run(
				'msg_001',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					time: { created: 1700000000000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 100, output: 50 },
				}),
			);
			insert.run(
				'msg_002',
				'ses_001',
				1700000001000,
				1700000001000,
				JSON.stringify({ role: 'user', time: { created: 1700000001000 } }),
			);
			insert.run(
				'msg_003',
				'ses_001',
				1700000002000,
				1700000002000,
				JSON.stringify({
					time: { created: 1700000002000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 0, output: 0 },
				}),
			);
			db.close();

			const entries = await loadOpenCodeMessages();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.sessionID).toBe('ses_001');
		});

		it('should deduplicate messages with the same id', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
			const data = JSON.stringify({
				time: { created: 1700000000000 },
				modelID: 'claude-sonnet-4-20250514',
				providerID: 'anthropic',
				tokens: { input: 100, output: 50 },
			});
			db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
				'msg_001',
				'ses_001',
				1700000000000,
				1700000010000,
				data,
			);
			db.close();

			const entries = await loadOpenCodeMessages();
			expect(entries).toHaveLength(1);
		});

		it('should load sessions from SQLite database', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
			db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
				'ses_001',
				'proj_abc',
				null,
				'my-session',
				'/home/user/myproject',
				'My Session',
			);
			db.close();

			const sessions = await loadOpenCodeSessions();

			expect(sessions.size).toBe(1);
			const session = sessions.get('ses_001');
			expect(session?.title).toBe('My Session');
			expect(session?.directory).toBe('/home/user/myproject');
			expect(session?.projectID).toBe('proj_abc');
			expect(session?.parentID).toBeNull();
		});

		it('should return empty arrays when no database exists in the data directory', async () => {
			// testDir is set by beforeEach but contains no opencode.db and no storage/message dir
			const entries = await loadOpenCodeMessages();
			const sessions = await loadOpenCodeSessions();

			expect(entries).toHaveLength(0);
			expect(sessions.size).toBe(0);
		});
	});
}
