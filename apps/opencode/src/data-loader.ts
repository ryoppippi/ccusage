/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data.
 * OpenCode >= 1.2.2 stores data in a SQLite database at ~/.local/share/opencode/opencode.db
 * Older versions stored data as JSON files in ~/.local/share/opencode/storage/message/
 *
 * @module data-loader
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDirectorySync } from 'path-type';
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
const OPENCODE_DB_FILENAME = 'opencode.db';

/**
 * Environment variable for specifying custom OpenCode data directory
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';

/**
 * User home directory
 */
const USER_HOME_DIR = homedir();
const require = createRequire(import.meta.url);

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

function getDbPath(openCodePath: string): string | null {
	const dbPath = path.join(openCodePath, OPENCODE_DB_FILENAME);
	return existsSync(dbPath) ? dbPath : null;
}

// ─── SQLite-based loading (OpenCode >= 1.2.2) ───────────────────────────────

const sqliteMessageDataSchema = v.object({
	role: v.optional(v.string()),
	providerID: v.optional(v.string()),
	modelID: v.optional(v.string()),
	tokens: v.optional(openCodeTokensSchema),
	cost: v.optional(v.number()),
	time: v.optional(
		v.object({
			created: v.optional(v.number()),
			completed: v.optional(v.number()),
		}),
	),
});

type SqliteRow = {
	[key: string]: unknown;
};

type SqliteAdapter = {
	queryAll: (sql: string) => SqliteRow[];
	close: () => void;
};

type BetterSqliteDatabase = {
	exec: (sql: string) => void;
	prepare: (sql: string) => {
		all: () => SqliteRow[];
		run: (...params: unknown[]) => unknown;
	};
	close: () => void;
};

type BunSqliteDatabase = {
	query: (sql: string) => { all: () => SqliteRow[] };
	close: () => void;
};

type LoadedOpenCodeData = {
	entries: LoadedUsageEntry[];
	sessionMetadataMap: Map<string, LoadedSessionMetadata>;
};

type BetterSqliteDatabaseConstructor = new (
	path: string,
	opts?: { readonly?: boolean },
) => BetterSqliteDatabase;

function requireBetterSqlite3(): BetterSqliteDatabaseConstructor {
	return require('better-sqlite3') as BetterSqliteDatabaseConstructor;
}

function createBetterSqliteAdapter(db: BetterSqliteDatabase): SqliteAdapter {
	return {
		queryAll(sql: string) {
			return db.prepare(sql).all();
		},
		close() {
			db.close();
		},
	};
}

function createBunSqliteAdapter(db: BunSqliteDatabase): SqliteAdapter {
	return {
		queryAll(sql: string) {
			return db.query(sql).all();
		},
		close() {
			db.close();
		},
	};
}

function openSqliteDb(dbPath: string): SqliteAdapter {
	let BetterSqlite3: BetterSqliteDatabaseConstructor | null = null;

	try {
		BetterSqlite3 = requireBetterSqlite3();
	} catch {
		// Fall back to Bun's SQLite adapter when better-sqlite3 is unavailable.
	}

	if (BetterSqlite3 != null) {
		try {
			return createBetterSqliteAdapter(new BetterSqlite3(dbPath, { readonly: true }));
		} catch {
			// Fall back to Bun's SQLite adapter when better-sqlite3 cannot open in Bun.
		}
	}

	const { Database } = require('bun:sqlite') as {
		Database: new (path: string, opts?: { readonly?: boolean }) => BunSqliteDatabase;
	};
	return createBunSqliteAdapter(new Database(dbPath, { readonly: true }));
}

function loadMessagesFromSqlite(db: SqliteAdapter): LoadedUsageEntry[] {
	const rows = db.queryAll(
		'SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC, id ASC',
	) as Array<{
		id: string;
		session_id: string;
		time_created: number;
		data: string;
	}>;

	const entries: LoadedUsageEntry[] = [];
	const dedupeSet = new Set<string>();

	for (const row of rows) {
		if (dedupeSet.has(row.id)) {
			continue;
		}
		dedupeSet.add(row.id);

		let parsed: unknown;
		try {
			parsed = JSON.parse(row.data);
		} catch {
			continue;
		}

		const result = v.safeParse(sqliteMessageDataSchema, parsed);
		if (!result.success) {
			continue;
		}

		const data = result.output;

		if (data.role !== 'assistant') {
			continue;
		}

		if (data.tokens == null || (data.tokens.input === 0 && data.tokens.output === 0)) {
			continue;
		}

		if (data.providerID == null || data.modelID == null) {
			continue;
		}

		const createdMs = data.time?.created ?? row.time_created;

		entries.push({
			timestamp: new Date(createdMs),
			sessionID: row.session_id,
			usage: {
				inputTokens: data.tokens?.input ?? 0,
				outputTokens: data.tokens?.output ?? 0,
				cacheCreationInputTokens: data.tokens?.cache?.write ?? 0,
				cacheReadInputTokens: data.tokens?.cache?.read ?? 0,
			},
			model: data.modelID,
			costUSD: data.cost ?? null,
		});
	}

	return entries;
}

function loadSessionsFromSqlite(db: SqliteAdapter): Map<string, LoadedSessionMetadata> {
	const rows = db.queryAll(
		'SELECT id, project_id, parent_id, title, directory FROM session ORDER BY time_created ASC, id ASC',
	) as Array<{
		id: string;
		project_id: string;
		parent_id: string | null;
		title: string;
		directory: string;
	}>;

	const sessionMap = new Map<string, LoadedSessionMetadata>();

	for (const row of rows) {
		sessionMap.set(row.id, {
			id: row.id,
			parentID: row.parent_id ?? null,
			title: row.title !== '' ? row.title : row.id,
			projectID: row.project_id !== '' ? row.project_id : 'unknown',
			directory: row.directory !== '' ? row.directory : 'unknown',
		});
	}

	return sessionMap;
}

function loadOpenCodeDataFromSqlite(dbPath: string): LoadedOpenCodeData {
	const db = openSqliteDb(dbPath);

	try {
		return {
			entries: loadMessagesFromSqlite(db),
			sessionMetadataMap: loadSessionsFromSqlite(db),
		};
	} finally {
		db.close();
	}
}

// ─── Legacy JSON file-based loading (OpenCode < 1.2.2) ──────────────────────

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

async function loadOpenCodeSessionsFromJson(
	openCodePath: string,
): Promise<Map<string, LoadedSessionMetadata>> {
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

async function loadOpenCodeMessagesFromJson(openCodePath: string): Promise<LoadedUsageEntry[]> {
	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);

	if (!isDirectorySync(messagesDir)) {
		return [];
	}

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

		if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
			continue;
		}

		if (message.providerID == null || message.modelID == null) {
			continue;
		}

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

function logSqliteFallback(context: 'messages' | 'sessions' | 'data', error: unknown): void {
	logger.warn(`Falling back to legacy OpenCode JSON ${context} after SQLite read failed.`);
	logger.warn(error);
}

export async function loadOpenCodeData(): Promise<LoadedOpenCodeData> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return {
			entries: [],
			sessionMetadataMap: new Map(),
		};
	}

	const dbPath = getDbPath(openCodePath);
	if (dbPath != null) {
		try {
			return loadOpenCodeDataFromSqlite(dbPath);
		} catch (error) {
			logSqliteFallback('data', error);
		}
	}

	const [entries, sessionMetadataMap] = await Promise.all([
		loadOpenCodeMessagesFromJson(openCodePath),
		loadOpenCodeSessionsFromJson(openCodePath),
	]);

	return {
		entries,
		sessionMetadataMap,
	};
}

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return new Map();
	}

	const dbPath = getDbPath(openCodePath);
	if (dbPath != null) {
		try {
			return loadOpenCodeDataFromSqlite(dbPath).sessionMetadataMap;
		} catch (error) {
			logSqliteFallback('sessions', error);
		}
	}

	return loadOpenCodeSessionsFromJson(openCodePath);
}

export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const dbPath = getDbPath(openCodePath);
	if (dbPath != null) {
		try {
			return loadOpenCodeDataFromSqlite(dbPath).entries;
		} catch (error) {
			logSqliteFallback('messages', error);
		}
	}

	return loadOpenCodeMessagesFromJson(openCodePath);
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	function createSqliteAdapter({
		messageRows = [],
		sessionRows = [],
	}: {
		messageRows?: SqliteRow[];
		sessionRows?: SqliteRow[];
	}): SqliteAdapter {
		return {
			queryAll(sql: string) {
				if (sql.includes('FROM message')) {
					return messageRows;
				}

				if (sql.includes('FROM session')) {
					return sessionRows;
				}

				throw new Error(`Unexpected SQL in test adapter: ${sql}`);
			},
			close() {},
		};
	}

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

		it('loads SQLite messages with filtering, dedupe, and timestamp fallback', () => {
			const db = createSqliteAdapter({
				messageRows: [
					{
						id: 'msg_primary',
						session_id: 'ses_root',
						time_created: 1500,
						data: JSON.stringify({
							role: 'assistant',
							providerID: 'openai',
							modelID: 'gpt-5.4',
							time: { created: 1111 },
							tokens: {
								input: 10,
								output: 20,
								cache: { read: 5, write: 1 },
							},
							cost: 0.25,
						}),
					},
					{
						id: 'msg_primary',
						session_id: 'ses_root',
						time_created: 1999,
						data: JSON.stringify({
							role: 'assistant',
							providerID: 'openai',
							modelID: 'gpt-5.4',
							time: { created: 1999 },
							tokens: { input: 999, output: 999 },
							cost: 9.99,
						}),
					},
					{
						id: 'msg_row_fallback',
						session_id: 'ses_child',
						time_created: 2222,
						data: JSON.stringify({
							role: 'assistant',
							providerID: 'anthropic',
							modelID: 'claude-sonnet-4-20250514',
							tokens: { input: 7, output: 3 },
						}),
					},
					{
						id: 'msg_user',
						session_id: 'ses_root',
						time_created: 4444,
						data: JSON.stringify({
							role: 'user',
							providerID: 'openai',
							modelID: 'gpt-5.4',
							tokens: { input: 999, output: 999 },
						}),
					},
					{
						id: 'msg_invalid',
						session_id: 'ses_root',
						time_created: 5555,
						data: '{invalid-json',
					},
				],
			});

			const entries = loadMessagesFromSqlite(db);

			expect(entries).toHaveLength(2);
			expect(entries).toEqual([
				{
					timestamp: new Date(1111),
					sessionID: 'ses_root',
					usage: {
						inputTokens: 10,
						outputTokens: 20,
						cacheCreationInputTokens: 1,
						cacheReadInputTokens: 5,
					},
					model: 'gpt-5.4',
					costUSD: 0.25,
				},
				{
					timestamp: new Date(2222),
					sessionID: 'ses_child',
					usage: {
						inputTokens: 7,
						outputTokens: 3,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
					},
					model: 'claude-sonnet-4-20250514',
					costUSD: null,
				},
			]);
		});

		it('loads SQLite sessions with fallback metadata', () => {
			const db = createSqliteAdapter({
				sessionRows: [
					{
						id: 'ses_root',
						project_id: 'proj_1',
						parent_id: null,
						title: 'Root Session',
						directory: '/tmp/project',
					},
					{
						id: 'ses_child',
						project_id: '',
						parent_id: 'ses_root',
						title: '',
						directory: '',
					},
				],
			});

			const sessionMetadataMap = loadSessionsFromSqlite(db);

			expect(sessionMetadataMap.get('ses_root')).toEqual({
				id: 'ses_root',
				parentID: null,
				title: 'Root Session',
				projectID: 'proj_1',
				directory: '/tmp/project',
			});
			expect(sessionMetadataMap.get('ses_child')).toEqual({
				id: 'ses_child',
				parentID: 'ses_root',
				title: 'ses_child',
				projectID: 'unknown',
				directory: 'unknown',
			});
		});
	});
}
