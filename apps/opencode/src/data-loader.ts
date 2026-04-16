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

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { logger } from './logger.ts';

const DEFAULT_OPENCODE_PATH = '.local/share/opencode';
const OPENCODE_STORAGE_DIR_NAME = 'storage';
const OPENCODE_MESSAGES_DIR_NAME = 'message';
const OPENCODE_SESSIONS_DIR_NAME = 'session';
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';
const USER_HOME_DIR = homedir();

const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);

const sessionIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Session ID cannot be empty'),
	v.brand('SessionId'),
);

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

type DbResult = {
	dbEntries: LoadedUsageEntry[];
	dbSessionMap: Map<string, LoadedSessionMetadata>;
	dbMessageIds: Set<string>;
	dbSessionIds: Set<string>;
};

type SqliteAdapter = {
	prepareAll: (sql: string) => Array<Record<string, unknown>>;
	close: () => void;
};

type BetterSqlite3 = typeof import('better-sqlite3');

let cachedOpenCodePath: string | null | undefined;

function isBunRuntime(): boolean {
	return 'Bun' in globalThis || process.versions.bun != null;
}

function createBetterSqlite3Adapter(DbModule: BetterSqlite3, dbPath: string): SqliteAdapter {
	const db = new DbModule(dbPath, { readonly: true });
	return {
		prepareAll(sql: string) {
			return db.prepare(sql).all() as Array<Record<string, unknown>>;
		},
		close() {
			db.close();
		},
	};
}

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
				query: (sql: string) => { all: () => Array<Record<string, unknown>> };
				close: () => void;
			};
		};
		const db = new Database(dbPath, { readonly: true });
		return {
			prepareAll(sql: string) {
				return db.query(sql).all();
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

function openSqliteDb(dbPath: string): SqliteAdapter | null {
	try {
		// eslint-disable-next-line ts/no-require-imports -- native addon, must use require for runtime resolution
		const DbModule = require('better-sqlite3') as BetterSqlite3;
		try {
			return createBetterSqlite3Adapter(DbModule, dbPath);
		} catch (error) {
			logger.debug('better-sqlite3 failed to open DB, trying bun:sqlite', {
				dbPath,
				error: String(error),
			});
		}
	} catch {
		logger.debug('better-sqlite3 module not available, trying bun:sqlite fallback');
	}

	return createBunSqliteAdapter(dbPath);
}

export function getOpenCodePath(): string | null {
	if (cachedOpenCodePath !== undefined) {
		return cachedOpenCodePath;
	}

	const envPath = process.env[OPENCODE_CONFIG_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			cachedOpenCodePath = normalizedPath;
			return normalizedPath;
		}
	}

	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_OPENCODE_PATH);
	if (isDirectorySync(defaultPath)) {
		cachedOpenCodePath = defaultPath;
		return defaultPath;
	}

	cachedOpenCodePath = null;
	return null;
}

export function resetOpenCodePathCache(): void {
	cachedOpenCodePath = undefined;
}

async function loadOpenCodeMessage(
	filePath: string,
): Promise<v.InferOutput<typeof openCodeMessageSchema> | null> {
	const readResult = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => new Error(String(error), { cause: error }),
	});
	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read OpenCode message file', {
			filePath,
			error: readResult.error.message,
		});
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => new Error(String(error), { cause: error }),
	})();
	if (Result.isFailure(parseResult)) {
		logger.debug('Failed to parse OpenCode message JSON', {
			filePath,
			error: parseResult.error.message,
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
	const readResult = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => new Error(String(error), { cause: error }),
	});
	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read OpenCode session file', {
			filePath,
			error: readResult.error.message,
		});
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => new Error(String(error), { cause: error }),
	})();
	if (Result.isFailure(parseResult)) {
		logger.debug('Failed to parse OpenCode session JSON', {
			filePath,
			error: parseResult.error.message,
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
		projectID: session.projectID ?? 'unknown',
		directory: session.directory ?? 'unknown',
	};
}

function getOpenCodeDbPath(): string | null {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}
	const defaultDbPath = path.join(openCodePath, 'opencode.db');
	if (existsSync(defaultDbPath)) {
		return defaultDbPath;
	}
	let dirEntries: string[];
	try {
		dirEntries = readdirSync(openCodePath);
	} catch {
		return null;
	}
	const channelDb = dirEntries.find((entry) => /^opencode-.+\.db$/.test(entry));
	if (channelDb != null) {
		return path.join(openCodePath, channelDb);
	}
	return null;
}

function loadFromDb(dbPath: string): DbResult | null {
	const db = openSqliteDb(dbPath);
	if (db == null) {
		logger.debug('No SQLite adapter available (tried better-sqlite3 and bun:sqlite)');
		return null;
	}

	try {
		const dbEntries: LoadedUsageEntry[] = [];
		const dbMessageIds = new Set<string>();
		const dbSessionMap = new Map<string, LoadedSessionMetadata>();
		const dbSessionIds = new Set<string>();

		const rows = db.prepareAll(`
			SELECT id, session_id, time_created, data
			FROM message
			WHERE json_extract(data, '$.tokens') IS NOT NULL
			  AND json_extract(data, '$.modelID') IS NOT NULL
			  AND json_extract(data, '$.providerID') IS NOT NULL
			  AND json_extract(data, '$.role') = 'assistant'
		`) as DbMessageRow[];

		for (const row of rows) {
			dbMessageIds.add(row.id);

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

			const schemaResult = v.safeParse(openCodeMessageSchema, merged);
			if (!schemaResult.success) {
				continue;
			}

			const message = schemaResult.output;
			if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
				continue;
			}

			if (message.providerID == null || message.modelID == null) {
				continue;
			}

			dbEntries.push(convertOpenCodeMessageToUsageEntry(message));
		}

		const sessionRows = db.prepareAll(
			'SELECT id, project_id, parent_id, title, directory FROM session',
		) as DbSessionRow[];

		for (const row of sessionRows) {
			dbSessionIds.add(row.id);

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

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return new Map();
	}

	const dbPath = getOpenCodeDbPath();
	let sessionMap = new Map<string, LoadedSessionMetadata>();

	if (dbPath != null) {
		const dbResult = loadFromDb(dbPath);
		if (dbResult != null) {
			sessionMap = dbResult.dbSessionMap;
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

	const dbSessionIds =
		dbPath != null && sessionMap.size > 0 ? new Set(sessionMap.keys()) : new Set<string>();

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

export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const dbPath = getOpenCodeDbPath();
	let entries: LoadedUsageEntry[] = [];
	const seenIds = new Set<string>();

	if (dbPath != null) {
		const dbResult = loadFromDb(dbPath);
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

		if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
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
	const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
	// eslint-disable-next-line ts/no-require-imports -- test-only native module import
	const Database = require('better-sqlite3') as BetterSqlite3;

	function createMockAdapter({
		messageRows,
		sessionRows,
	}: {
		messageRows: DbMessageRow[];
		sessionRows: DbSessionRow[];
	}): SqliteAdapter {
		return {
			prepareAll(sql: string) {
				if (sql.includes('FROM message')) {
					return messageRows as unknown as Array<Record<string, unknown>>;
				}
				if (sql.includes('FROM session')) {
					return sessionRows as unknown as Array<Record<string, unknown>>;
				}
				return [];
			},
			close() {},
		};
	}

	function loadFromDbWithAdapter(adapter: SqliteAdapter): DbResult | null {
		try {
			const dbEntries: LoadedUsageEntry[] = [];
			const dbMessageIds = new Set<string>();
			const dbSessionMap = new Map<string, LoadedSessionMetadata>();
			const dbSessionIds = new Set<string>();

			const rows = adapter.prepareAll(`
				SELECT id, session_id, time_created, data
				FROM message
				WHERE json_extract(data, '$.tokens') IS NOT NULL
				  AND json_extract(data, '$.modelID') IS NOT NULL
				  AND json_extract(data, '$.providerID') IS NOT NULL
				  AND json_extract(data, '$.role') = 'assistant'
			`) as DbMessageRow[];

			for (const row of rows) {
				dbMessageIds.add(row.id);

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

				const schemaResult = v.safeParse(openCodeMessageSchema, merged);
				if (!schemaResult.success) {
					continue;
				}

				const message = schemaResult.output;
				if (message.tokens == null || (message.tokens.input === 0 && message.tokens.output === 0)) {
					continue;
				}

				if (message.providerID == null || message.modelID == null) {
					continue;
				}

				dbEntries.push(convertOpenCodeMessageToUsageEntry(message));
			}

			const sessionRows = adapter.prepareAll(
				'SELECT id, project_id, parent_id, title, directory FROM session',
			) as DbSessionRow[];

			for (const row of sessionRows) {
				dbSessionIds.add(row.id);

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
				dbSessionMap.set(metadata.id, metadata);
			}

			return { dbEntries, dbSessionMap, dbMessageIds, dbSessionIds };
		} catch (error) {
			logger.debug('Failed to load from mock adapter', { error: String(error) });
			return null;
		} finally {
			adapter.close();
		}
	}

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
			resetOpenCodePathCache();
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
			resetOpenCodePathCache();
		});

		it('should load messages from SQLite database', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
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

			const entries = await loadOpenCodeMessages();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.sessionID).toBe('ses_001');
		});

		it('should return empty when database fails to open', async () => {
			const entries = await loadOpenCodeMessages();
			expect(entries).toHaveLength(0);
		});

		it('should return empty when database is corrupt', async () => {
			const corruptPath = path.join(testDir, 'opencode.db');
			writeFileSync(corruptPath, 'not a sqlite database');

			const entries = await loadOpenCodeMessages();
			expect(entries).toHaveLength(0);
		});

		it('should merge DB and legacy file messages', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
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

			const messagesDir = path.join(testDir, OPENCODE_STORAGE_DIR_NAME, OPENCODE_MESSAGES_DIR_NAME);
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

			const entries = await loadOpenCodeMessages();
			expect(entries).toHaveLength(2);
		});

		it('should not duplicate messages present in both DB and legacy files', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
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

			const messagesDir = path.join(testDir, OPENCODE_STORAGE_DIR_NAME, OPENCODE_MESSAGES_DIR_NAME);
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

		it('should merge DB and legacy file sessions', async () => {
			const db = createTestDb(path.join(testDir, 'opencode.db'));
			db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
				'ses_db_001',
				'proj_abc',
				null,
				'db-session',
				'/home/user/project1',
				'DB Session',
			);
			db.close();

			const sessionsDir = path.join(testDir, OPENCODE_STORAGE_DIR_NAME, OPENCODE_SESSIONS_DIR_NAME);
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

			const sessions = await loadOpenCodeSessions();
			expect(sessions.size).toBe(2);
			expect(sessions.get('ses_db_001')?.title).toBe('DB Session');
			expect(sessions.get('ses_file_001')?.title).toBe('File Session');
		});

		it('should return empty when no database or legacy files exist', async () => {
			const entries = await loadOpenCodeMessages();
			const sessions = await loadOpenCodeSessions();

			expect(entries).toHaveLength(0);
			expect(sessions.size).toBe(0);
		});

		it('should load from channel-variant DB (opencode-beta.db)', async () => {
			const db = createTestDb(path.join(testDir, 'opencode-beta.db'));
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

			const entries = await loadOpenCodeMessages();
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
			const result = loadFromDbWithAdapter(mockAdapter);
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
			const result = loadFromDbWithAdapter(mockAdapter);
			expect(result).not.toBeNull();
			expect(result!.dbEntries).toHaveLength(1);
			expect(result!.dbMessageIds).toContain('msg_bad');
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
			const result = loadFromDbWithAdapter(mockAdapter);
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
			const result = loadFromDbWithAdapter(mockAdapter);
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
			const result = loadFromDbWithAdapter(mockAdapter);
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
			const result = loadFromDbWithAdapter(mockAdapter);
			expect(result).toBeNull();
		});
	});
}
