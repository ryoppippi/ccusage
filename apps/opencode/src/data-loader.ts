/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data
 * from JSON message files or a SQLite database stored in OpenCode data directories.
 * OpenCode stores usage data in ~/.local/share/opencode/opencode.db (newer versions)
 * or ~/.local/share/opencode/storage/message/ (older versions).
 * When both sources exist, data is merged with DB entries taking precedence by ID.
 *
 * @module data-loader
 */

import type {
	BetterSqlite3,
	DbMessageRow,
	DbResult,
	DbSessionRow,
	LoadedSessionMetadata,
	LoadedUsageEntry,
	SqliteAdapter,
} from './_types.ts';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	CHANNEL_DB_PATTERN,
	DEFAULT_OPENCODE_PATH,
	OPENCODE_CONFIG_DIR_ENV,
	OPENCODE_MESSAGES_DIR_NAME,
	OPENCODE_SESSIONS_DIR_NAME,
	OPENCODE_STORAGE_DIR_NAME,
	USER_HOME_DIR,
} from './_consts.ts';
import { modelNameSchema, sessionIdSchema } from './_types.ts';
import { logger } from './logger.ts';

const openCodeTokensSchema = v.object({
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

const openCodeMessageSchema = v.object({
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
	role: v.optional(v.string()),
});

const openCodeSessionSchema = v.object({
	id: sessionIdSchema,
	parentID: v.optional(v.nullable(sessionIdSchema)),
	title: v.optional(v.string()),
	projectID: v.optional(v.string()),
	directory: v.optional(v.string()),
});

// undefined = not yet resolved, null = resolved but not found, string = resolved path
let _cachedOpenCodePath: string | null | undefined;

const MAX_MESSAGE_DATA_LENGTH = 1024 * 1024; // 1MB limit per row.data JSON field

/**
 * Fallback value used when a message or database row has no model information.
 * This appears in output data when modelID is missing or invalid.
 */
const UNKNOWN_MODEL = 'unknown' as const;

/**
 * Fallback value used when a message has no session ID.
 * This appears in output data when sessionID is missing.
 */
const UNKNOWN_SESSION_ID = 'unknown' as const;

/**
 * Fallback value used when session metadata has no project ID.
 * This appears in output data when projectID is missing.
 */
const UNKNOWN_PROJECT = 'unknown' as const;

/**
 * Fallback value used when session metadata has no directory information.
 * This appears in output data when directory is missing.
 */
const UNKNOWN_DIRECTORY = 'unknown' as const;

/**
 * Detects if running in the Bun JavaScript runtime.
 */
function isBunRuntime(): boolean {
	return 'Bun' in globalThis || process.versions.bun != null;
}

/**
 * Creates a SqliteAdapter wrapping better-sqlite3 with a readonly connection.
 */
function createBetterSqlite3Adapter(DbModule: BetterSqlite3, dbPath: string): SqliteAdapter {
	const db = new DbModule(dbPath, { readonly: true });
	return {
		prepareAll<T>(sql: string): Array<T> {
			return db.prepare(sql).all() as Array<T>;
		},
		close() {
			db.close();
		},
	};
}

/**
 * Creates a SqliteAdapter wrapping bun:sqlite with a readonly connection.
 * Returns null if not running in Bun or if bun:sqlite fails to load.
 */
function createBunSqliteAdapter(dbPath: string): SqliteAdapter | null {
	if (!isBunRuntime()) {
		return null;
	}
	try {
		// eslint-disable-next-line ts/no-require-imports -- Bun built-in, must use require for runtime resolution
		const { Database } = require('bun:sqlite') as {
			Database: new (
				path: string,
				opts?: { readonly?: boolean },
			) => {
				query: <T>(sql: string) => { all: () => Array<T> };
				close: () => void;
			};
		};
		const db = new Database(dbPath, { readonly: true });
		return {
			prepareAll<T>(sql: string): Array<T> {
				return db.query<T>(sql).all();
			},
			close() {
				db.close();
			},
		};
	} catch (error) {
		logger.debug('Failed to open bun:sqlite fallback', { error: String(error) });
		return null;
	}
}

/**
 * Opens a SQLite database using the best available driver.
 * Tries better-sqlite3 first (Node.js), falls back to bun:sqlite (Bun runtime).
 * Returns null if no adapter is available or the DB cannot be opened.
 */
function openSqliteDb(dbPath: string): SqliteAdapter | null {
	try {
		// eslint-disable-next-line ts/no-require-imports -- native addon, must use require for runtime resolution
		const DbModule = require('better-sqlite3') as unknown;
		if (typeof DbModule !== 'function') {
			logger.debug('better-sqlite3 module has unexpected shape, trying bun:sqlite fallback');
		} else {
			try {
				return createBetterSqlite3Adapter(DbModule as BetterSqlite3, dbPath);
			} catch (error) {
				logger.debug('better-sqlite3 failed to open DB, falling back to bun:sqlite', {
					dbPath,
					error: String(error),
				});
			}
		}
	} catch {
		logger.debug('better-sqlite3 module not available, trying bun:sqlite fallback');
	}

	return createBunSqliteAdapter(dbPath);
}

/**
 * Gets the OpenCode data directory path.
 * Checks OPENCODE_DATA_DIR env var first, then ~/.local/share/opencode.
 * Result is cached; call resetOpenCodePathCache() to clear.
 * @returns Path to OpenCode data directory, or null if not found
 */
export function getOpenCodePath(): string | null {
	if (_cachedOpenCodePath !== undefined) {
		return _cachedOpenCodePath;
	}

	const envPath = process.env[OPENCODE_CONFIG_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			_cachedOpenCodePath = normalizedPath;
			return normalizedPath;
		}
	}

	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_OPENCODE_PATH);
	if (isDirectorySync(defaultPath)) {
		_cachedOpenCodePath = defaultPath;
		return defaultPath;
	}

	_cachedOpenCodePath = null;
	return null;
}

/**
 * Clears the cached OpenCode path and DB result caches.
 * Exported for use in tests to reset state between test cases.
 */
export function resetOpenCodePathCache(): void {
	_cachedOpenCodePath = undefined;
	_clearOpenCodeDbCache();
}

async function loadOpenCodeMessage(
	filePath: string,
): Promise<v.InferOutput<typeof openCodeMessageSchema> | null> {
	const readResult = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => error,
	});
	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read OpenCode message file', {
			filePath,
			error: String(readResult.error),
		});
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(parseResult)) {
		logger.debug('Failed to parse OpenCode message JSON', {
			filePath,
			error: String(parseResult.error),
		});
		return null;
	}

	const schemaResult = v.safeParse(openCodeMessageSchema, parseResult.value);
	if (!schemaResult.success) {
		logger.debug('OpenCode message failed schema validation', {
			filePath,
			issues: schemaResult.issues,
		});
		return null;
	}

	return schemaResult.output;
}

function convertOpenCodeMessageToUsageEntry(
	message: v.InferOutput<typeof openCodeMessageSchema>,
): LoadedUsageEntry {
	const createdMs = message.time.created ?? Date.now();

	return {
		timestamp: new Date(createdMs),
		sessionID: message.sessionID ?? UNKNOWN_SESSION_ID,
		usage: {
			inputTokens: message.tokens?.input ?? 0,
			outputTokens: message.tokens?.output ?? 0,
			cacheCreationInputTokens: message.tokens?.cache?.write ?? 0,
			cacheReadInputTokens: message.tokens?.cache?.read ?? 0,
		},
		model: message.modelID ?? UNKNOWN_MODEL,
		costUSD: message.cost ?? null,
	};
}

async function loadOpenCodeSession(
	filePath: string,
): Promise<v.InferOutput<typeof openCodeSessionSchema> | null> {
	const readResult = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => error,
	});
	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read OpenCode session file', {
			filePath,
			error: String(readResult.error),
		});
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(parseResult)) {
		logger.debug('Failed to parse OpenCode session JSON', {
			filePath,
			error: String(parseResult.error),
		});
		return null;
	}

	const schemaResult = v.safeParse(openCodeSessionSchema, parseResult.value);
	if (!schemaResult.success) {
		logger.debug('OpenCode session failed schema validation', {
			filePath,
			issues: schemaResult.issues,
		});
		return null;
	}

	return schemaResult.output;
}

function convertOpenCodeSessionToMetadata(
	session: v.InferOutput<typeof openCodeSessionSchema>,
): LoadedSessionMetadata {
	return {
		id: session.id,
		parentID: session.parentID ?? null,
		title: session.title ?? session.id,
		projectID: session.projectID ?? UNKNOWN_PROJECT,
		directory: session.directory ?? UNKNOWN_DIRECTORY,
	};
}

/**
 * Finds the SQLite database path in the OpenCode data directory.
 * Prefers opencode.db; falls back to channel-variant DBs (opencode-beta.db, etc.).
 * Validates symlinks to prevent path traversal attacks.
 */
function getOpenCodeDbPath(): string | null {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}
	// Resolve the base path once to handle symlinks in the path
	const resolvedOpenCodePath = realpathSync(openCodePath);
	const defaultDbPath = path.join(openCodePath, 'opencode.db');
	if (existsSync(defaultDbPath)) {
		let resolvedPath: string | undefined;
		try {
			resolvedPath = realpathSync(defaultDbPath);
		} catch (error) {
			logger.debug('Failed to resolve default DB symlink, skipping', {
				defaultDbPath,
				error: String(error),
			});
		}
		if (resolvedPath !== undefined) {
			if (
				!resolvedPath.startsWith(resolvedOpenCodePath + path.sep) &&
				resolvedPath !== resolvedOpenCodePath
			) {
				logger.debug('Default DB resolved to path outside OpenCode directory, skipping', {
					defaultDbPath,
					resolvedPath,
					openCodePath,
				});
			} else {
				return defaultDbPath;
			}
		}
	}
	let dirEntries: string[];
	try {
		dirEntries = readdirSync(openCodePath);
	} catch (error) {
		logger.debug('Failed to read OpenCode data directory', { openCodePath, error: String(error) });
		return null;
	}
	const matchingDbs = dirEntries.filter((entry) => CHANNEL_DB_PATTERN.test(entry)).sort();
	if (matchingDbs.length > 1) {
		logger.debug('Multiple channel DBs found, selecting first alphabetically', {
			openCodePath,
			matchingDbs,
		});
	}
	if (matchingDbs.length > 0) {
		const channelDb = matchingDbs[0]!;
		const fullPath = path.join(openCodePath, channelDb);
		let resolvedPath: string;
		try {
			resolvedPath = realpathSync(fullPath);
		} catch (error) {
			logger.debug('Failed to resolve channel DB symlink, skipping', {
				fullPath,
				error: String(error),
			});
			return null;
		}
		if (!resolvedPath.startsWith(resolvedOpenCodePath + path.sep)) {
			logger.debug('Channel DB resolved to path outside OpenCode directory, skipping', {
				fullPath,
				resolvedPath,
				openCodePath,
			});
			return null;
		}
		return fullPath;
	}
	return null;
}

/**
 * Loads all usage messages and session metadata from a SQLite database.
 * Filters to assistant-role messages with valid tokens and model/provider.
 * Closes the adapter before returning (caller should not close).
 * Returns null on adapter failure or query error.
 *
 * @param dbPath - Path to the SQLite database file
 * @param adapter - Optional SqliteAdapter for database access; typically created by
 *                  createBetterSqlite3Adapter() or createBunSqliteAdapter().
 *                  If not provided, the function will attempt to open the database
 *                  using the best available driver (better-sqlite3 or bun:sqlite).
 */
function loadFromDb(dbPath: string, adapter?: SqliteAdapter): DbResult | null {
	const db = adapter ?? openSqliteDb(dbPath);
	if (db == null) {
		logger.debug('No SQLite adapter available (tried better-sqlite3 and bun:sqlite)');
		return null;
	}

	try {
		const dbEntries: LoadedUsageEntry[] = [];
		const dbMessageIds = new Set<string>();
		const dbSessionMap = new Map<string, LoadedSessionMetadata>();
		const dbSessionIds = new Set<string>();

		const rows = db.prepareAll<DbMessageRow>(`
			SELECT id, session_id, time_created, data
			FROM message
			WHERE json_extract(data, '$.tokens') IS NOT NULL
			  AND json_extract(data, '$.modelID') IS NOT NULL
			  AND json_extract(data, '$.providerID') IS NOT NULL
			  AND json_extract(data, '$.role') = 'assistant'
		`);

		for (const row of rows) {
			if (row.data.length > MAX_MESSAGE_DATA_LENGTH) {
				logger.debug('Message data exceeds size limit, skipping', {
					id: row.id,
					length: row.data.length,
				});
				continue;
			}
			let parsedData: unknown;
			try {
				parsedData = JSON.parse(row.data);
			} catch (error) {
				logger.debug('Failed to parse message data JSON', { id: row.id, error: String(error) });
				continue;
			}

			const merged =
				typeof parsedData === 'object' && parsedData !== null
					? { ...parsedData, id: row.id, sessionID: row.session_id }
					: { id: row.id, sessionID: row.session_id };

			const schemaResult = v.safeParse(openCodeMessageSchema, merged);
			if (!schemaResult.success) {
				continue;
			}

			const message = schemaResult.output;
			if (message.role !== 'assistant') {
				continue;
			}

			const hasUsage =
				(message.tokens?.input ?? 0) > 0 ||
				(message.tokens?.output ?? 0) > 0 ||
				(message.tokens?.cache?.read ?? 0) > 0 ||
				(message.tokens?.cache?.write ?? 0) > 0;
			if (!hasUsage) {
				continue;
			}

			if (message.providerID == null || message.modelID == null) {
				continue;
			}

			dbEntries.push(convertOpenCodeMessageToUsageEntry(message));
			dbMessageIds.add(row.id);
		}

		const sessionRows = db.prepareAll<DbSessionRow>(
			'SELECT id, project_id, parent_id, title, directory FROM session',
		);

		for (const row of sessionRows) {
			const schemaResult = v.safeParse(openCodeSessionSchema, {
				id: row.id,
				parentID: row.parent_id ?? null,
				title: row.title,
				projectID: row.project_id,
				directory: row.directory,
			});
			if (!schemaResult.success) {
				continue;
			}
			const metadata = convertOpenCodeSessionToMetadata(schemaResult.output);
			dbSessionIds.add(row.id);
			dbSessionMap.set(metadata.id, metadata);
		}

		return { dbEntries, dbSessionMap, dbMessageIds, dbSessionIds };
	} catch (error) {
		logger.debug('Failed to load from OpenCode SQLite database', { dbPath, error: String(error) });
		return null;
	} finally {
		db.close();
	}
}

// null = not yet loaded, { dbPath, result } = loaded data (invalidated by resetOpenCodePathCache())
let _cachedDbResult: { dbPath: string; result: DbResult } | null = null;

function _getOpenCodeDataFromDb(dbPath: string): DbResult | null {
	if (_cachedDbResult != null && _cachedDbResult.dbPath === dbPath) {
		return _cachedDbResult.result;
	}
	_cachedDbResult = null;
	const result = loadFromDb(dbPath);
	if (result != null) {
		_cachedDbResult = { dbPath, result };
	}
	return result;
}

function _clearOpenCodeDbCache(): void {
	_cachedDbResult = null;
}

/**
 * Loads OpenCode session metadata from SQLite database and legacy JSON files.
 * DB entries take precedence by ID when both sources contain the same session.
 * Returns an empty Map if no OpenCode data directory is found.
 *
 * Results from the SQLite database are cached; call resetOpenCodePathCache() to force a fresh read.
 */
export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return new Map();
	}

	const dbPath = getOpenCodeDbPath();
	let sessionMap = new Map<string, LoadedSessionMetadata>();
	const dbSessionIds = new Set<string>();

	if (dbPath != null) {
		const dbResult = _getOpenCodeDataFromDb(dbPath);
		if (dbResult != null) {
			sessionMap = dbResult.dbSessionMap;
			for (const id of dbResult.dbSessionIds) {
				dbSessionIds.add(id);
			}
		}
	}

	const sessionsDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_SESSIONS_DIR_NAME,
	);
	if (!isDirectorySync(sessionsDir)) {
		return sessionMap;
	}

	const sessionFiles = await glob('**/*.json', {
		cwd: sessionsDir,
		absolute: true,
	});

	for (const filePath of sessionFiles) {
		const session = await loadOpenCodeSession(filePath);
		if (session == null) {
			continue;
		}
		const metadata = convertOpenCodeSessionToMetadata(session);
		if (dbSessionIds.has(metadata.id)) {
			continue;
		}
		sessionMap.set(metadata.id, metadata);
	}

	return sessionMap;
}

/**
 * Loads OpenCode usage entries from SQLite database and legacy JSON files.
 * Filters to assistant-role messages with non-zero tokens and valid modelID/providerID.
 * DB entries take precedence by ID when both sources contain the same message.
 * Returns an empty array if no OpenCode data directory is found.
 *
 * Results from the SQLite database are cached; call resetOpenCodePathCache() to force a fresh read.
 */
export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const dbPath = getOpenCodeDbPath();
	let entries: LoadedUsageEntry[] = [];
	const seenIds = new Set<string>();

	if (dbPath != null) {
		const dbResult = _getOpenCodeDataFromDb(dbPath);
		if (dbResult != null) {
			entries = dbResult.dbEntries;
			for (const id of dbResult.dbMessageIds) {
				seenIds.add(id);
			}
		}
	}

	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);
	if (!isDirectorySync(messagesDir)) {
		return entries;
	}

	const messageFiles = await glob('**/*.json', {
		cwd: messagesDir,
		absolute: true,
	});

	for (const filePath of messageFiles) {
		const message = await loadOpenCodeMessage(filePath);
		if (message == null) {
			continue;
		}

		const hasUsage =
			(message.tokens?.input ?? 0) > 0 ||
			(message.tokens?.output ?? 0) > 0 ||
			(message.tokens?.cache?.read ?? 0) > 0 ||
			(message.tokens?.cache?.write ?? 0) > 0;
		if (!hasUsage) {
			continue;
		}

		if (message.providerID == null || message.modelID == null) {
			continue;
		}

		if (seenIds.has(message.id)) {
			continue;
		}
		seenIds.add(message.id);

		entries.push(convertOpenCodeMessageToUsageEntry(message));
	}

	return entries;
}

if (import.meta.vitest != null) {
	// eslint-disable-next-line ts/no-require-imports -- test-only native module import
	const Database = require('better-sqlite3') as BetterSqlite3;
	// eslint-disable-next-line ts/no-require-imports -- test-only module import
	const { createFixture } = require('fs-fixture') as typeof import('fs-fixture');

	function createMockAdapter({
		messageRows,
		sessionRows,
	}: {
		messageRows: DbMessageRow[];
		sessionRows: DbSessionRow[];
	}): SqliteAdapter {
		return {
			prepareAll<T>(sql: string): Array<T> {
				if (sql.includes('FROM message')) {
					return messageRows as unknown as Array<T>;
				}
				if (sql.includes('FROM session')) {
					return sessionRows as unknown as Array<T>;
				}
				return [] as Array<T>;
			},
			close() {},
		};
	}

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

	const withEnv = async <T>(
		envVar: string,
		value: string | undefined,
		fn: () => Promise<T>,
	): Promise<T> => {
		const orig = process.env[envVar];
		resetOpenCodePathCache();
		if (value === undefined) {
			delete process.env[envVar];
		} else {
			process.env[envVar] = value;
		}
		try {
			return await fn();
		} finally {
			if (orig === undefined) {
				delete process.env[envVar];
			} else {
				process.env[envVar] = orig;
			}
			resetOpenCodePathCache();
		}
	};

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
		it('should load messages from SQLite database', async () => {
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode.db'));
			db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
				'msg_001',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					role: 'assistant',
					time: { created: 1700000000000, completed: 1700000010000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 100, output: 200, cache: { read: 50, write: 25 } },
					cost: 0.001,
				}),
			);
			db.close();

			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);

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
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode.db'));
			const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
			insert.run(
				'msg_001',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					role: 'assistant',
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
					role: 'assistant',
					time: { created: 1700000002000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 0, output: 0 },
				}),
			);
			db.close();

			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.sessionID).toBe('ses_001');
		});

		it('should return empty when database fails to open', async () => {
			await using fixture = await createFixture({});
			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);
			expect(entries).toHaveLength(0);
		});

		it('should return empty when database is corrupt', async () => {
			await using fixture = await createFixture({
				'opencode.db': 'not a sqlite database',
			});

			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);
			expect(entries).toHaveLength(0);
		});

		it('should merge DB and legacy file messages', async () => {
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode.db'));
			db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
				'msg_db_001',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					role: 'assistant',
					time: { created: 1700000000000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 100, output: 50 },
				}),
			);
			db.close();

			const messagesDir = path.join(
				fixture.getPath(),
				OPENCODE_STORAGE_DIR_NAME,
				OPENCODE_MESSAGES_DIR_NAME,
			);
			mkdirSync(messagesDir, { recursive: true });
			writeFileSync(
				path.join(messagesDir, 'msg_file_001.json'),
				JSON.stringify({
					id: 'msg_file_001',
					sessionID: 'ses_002',
					providerID: 'anthropic',
					modelID: 'claude-sonnet-4-20250514',
					time: { created: 1700000000000 },
					tokens: { input: 200, output: 100 },
				}),
			);

			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);
			expect(entries).toHaveLength(2);
		});

		it('should not duplicate messages present in both DB and legacy files', async () => {
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode.db'));
			db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
				'msg_shared',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					role: 'assistant',
					time: { created: 1700000000000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 100, output: 50 },
				}),
			);
			db.close();

			const messagesDir = path.join(
				fixture.getPath(),
				OPENCODE_STORAGE_DIR_NAME,
				OPENCODE_MESSAGES_DIR_NAME,
			);
			mkdirSync(messagesDir, { recursive: true });
			writeFileSync(
				path.join(messagesDir, 'msg_shared.json'),
				JSON.stringify({
					id: 'msg_shared',
					sessionID: 'ses_001',
					providerID: 'anthropic',
					modelID: 'claude-sonnet-4-20250514',
					time: { created: 1700000000000 },
					tokens: { input: 100, output: 50 },
				}),
			);

			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);
			expect(entries).toHaveLength(1);
		});

		it('should load sessions from SQLite database', async () => {
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode.db'));
			db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
				'ses_001',
				'proj_abc',
				null,
				'my-session',
				'/home/user/myproject',
				'My Session',
			);
			db.close();

			const sessions = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeSessions,
			);

			expect(sessions.size).toBe(1);
			const session = sessions.get('ses_001');
			expect(session?.title).toBe('My Session');
			expect(session?.directory).toBe('/home/user/myproject');
			expect(session?.projectID).toBe('proj_abc');
			expect(session?.parentID).toBeNull();
		});

		it('should merge DB and legacy file sessions', async () => {
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode.db'));
			db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
				'ses_db_001',
				'proj_abc',
				null,
				'db-session',
				'/home/user/project1',
				'DB Session',
			);
			db.close();

			const sessionsDir = path.join(
				fixture.getPath(),
				OPENCODE_STORAGE_DIR_NAME,
				OPENCODE_SESSIONS_DIR_NAME,
			);
			mkdirSync(sessionsDir, { recursive: true });
			writeFileSync(
				path.join(sessionsDir, 'ses_file_001.json'),
				JSON.stringify({
					id: 'ses_file_001',
					parentID: null,
					title: 'File Session',
					projectID: 'proj_xyz',
					directory: '/home/user/project2',
				}),
			);

			const sessions = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeSessions,
			);
			expect(sessions.size).toBe(2);
			expect(sessions.get('ses_db_001')?.title).toBe('DB Session');
			expect(sessions.get('ses_file_001')?.title).toBe('File Session');
		});

		it('should return empty when no database or legacy files exist', async () => {
			await using fixture = await createFixture({});
			const [entries, sessions] = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				async () => {
					return [await loadOpenCodeMessages(), await loadOpenCodeSessions()] as const;
				},
			);

			expect(entries).toHaveLength(0);
			expect(sessions.size).toBe(0);
		});

		it('should load from channel-variant DB (opencode-beta.db)', async () => {
			await using fixture = await createFixture({});
			const db = createTestDb(fixture.getPath('opencode-beta.db'));
			db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
				'msg_001',
				'ses_001',
				1700000000000,
				1700000010000,
				JSON.stringify({
					role: 'assistant',
					time: { created: 1700000000000 },
					modelID: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					tokens: { input: 100, output: 50 },
				}),
			);
			db.close();

			const entries = await withEnv(
				OPENCODE_CONFIG_DIR_ENV,
				fixture.getPath(),
				loadOpenCodeMessages,
			);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.sessionID).toBe('ses_001');
		});
	});

	describe('loadFromDb with mock adapter', () => {
		it('should filter to assistant-role messages only', () => {
			const mockAdapter = createMockAdapter({
				messageRows: [
					{
						id: 'msg_user',
						session_id: 'ses_001',
						time_created: 1700000000000,
						data: JSON.stringify({
							role: 'user',
							time: { created: 1700000000000 },
						}),
					},
					{
						id: 'msg_asst',
						session_id: 'ses_001',
						time_created: 1700000001000,
						data: JSON.stringify({
							role: 'assistant',
							modelID: 'claude-sonnet-4-20250514',
							providerID: 'anthropic',
							tokens: { input: 50, output: 10 },
							time: { created: 1700000001000 },
						}),
					},
				],
				sessionRows: [],
			});
			const result = loadFromDb(':memory:', mockAdapter);
			expect(result).not.toBeNull();
			expect(result!.dbEntries).toHaveLength(1);
			expect(result!.dbEntries[0]?.model).toBe('claude-sonnet-4-20250514');
		});

		it('should skip messages with malformed JSON data', () => {
			const mockAdapter = createMockAdapter({
				messageRows: [
					{
						id: 'msg_bad',
						session_id: 'ses_001',
						time_created: 1700000000000,
						data: 'not-json',
					},
					{
						id: 'msg_good',
						session_id: 'ses_001',
						time_created: 1700000001000,
						data: JSON.stringify({
							role: 'assistant',
							modelID: 'claude-sonnet-4-20250514',
							providerID: 'anthropic',
							tokens: { input: 50, output: 10 },
							time: { created: 1700000001000 },
						}),
					},
				],
				sessionRows: [],
			});
			const result = loadFromDb(':memory:', mockAdapter);
			expect(result).not.toBeNull();
			expect(result!.dbEntries).toHaveLength(1);
			expect(result!.dbMessageIds).not.toContain('msg_bad');
			expect(result!.dbMessageIds).toContain('msg_good');
		});

		it('should skip messages missing modelID or providerID', () => {
			const mockAdapter = createMockAdapter({
				messageRows: [
					{
						id: 'msg_no_model',
						session_id: 'ses_001',
						time_created: 1700000000000,
						data: JSON.stringify({
							role: 'assistant',
							providerID: 'anthropic',
							tokens: { input: 50, output: 10 },
							time: { created: 1700000000000 },
						}),
					},
					{
						id: 'msg_no_provider',
						session_id: 'ses_001',
						time_created: 1700000001000,
						data: JSON.stringify({
							role: 'assistant',
							modelID: 'claude-sonnet-4-20250514',
							tokens: { input: 50, output: 10 },
							time: { created: 1700000001000 },
						}),
					},
				],
				sessionRows: [],
			});
			const result = loadFromDb(':memory:', mockAdapter);
			expect(result).not.toBeNull();
			expect(result!.dbEntries).toHaveLength(0);
		});

		it('should skip messages with zero tokens', () => {
			const mockAdapter = createMockAdapter({
				messageRows: [
					{
						id: 'msg_zero',
						session_id: 'ses_001',
						time_created: 1700000000000,
						data: JSON.stringify({
							role: 'assistant',
							modelID: 'claude-sonnet-4-20250514',
							providerID: 'anthropic',
							tokens: { input: 0, output: 0 },
							time: { created: 1700000000000 },
						}),
					},
				],
				sessionRows: [],
			});
			const result = loadFromDb(':memory:', mockAdapter);
			expect(result).not.toBeNull();
			expect(result!.dbEntries).toHaveLength(0);
		});

		it('should load session metadata from session table', () => {
			const mockAdapter = createMockAdapter({
				messageRows: [],
				sessionRows: [
					{
						id: 'ses_001',
						project_id: 'proj_abc',
						parent_id: null,
						title: 'Test Session',
						directory: '/home/user/project',
					},
				],
			});
			const result = loadFromDb(':memory:', mockAdapter);
			expect(result).not.toBeNull();
			expect(result!.dbSessionMap.size).toBe(1);
			expect(result!.dbSessionMap.get('ses_001')?.title).toBe('Test Session');
		});

		it('should handle adapter that throws on query', () => {
			const mockAdapter: SqliteAdapter = {
				prepareAll() {
					throw new Error('database disk image is malformed');
				},
				close() {},
			};
			const result = loadFromDb(':memory:', mockAdapter);
			expect(result).toBeNull();
		});
	});
}
