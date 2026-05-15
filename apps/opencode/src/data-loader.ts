/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data
 * from JSON message files stored in OpenCode data directories.
 * OpenCode stores usage data in ~/.local/share/opencode/storage/message/
 *
 * @module data-loader
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
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
const OPENCODE_DB_FILE_NAME = 'opencode.db';
const OPENCODE_CHANNEL_DB_PATTERN = /^opencode-[\w-]+\.db$/u;

/**
 * Environment variable for specifying custom OpenCode data directory
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';

/**
 * User home directory
 */
const USER_HOME_DIR = homedir();

type SqliteStatement = {
	all: (...params: unknown[]) => unknown[];
	run: (...params: unknown[]) => unknown;
};

type SqliteDatabase = {
	close: () => void;
	exec: (sql: string) => unknown;
	prepare: (sql: string) => SqliteStatement;
};

type SqliteDatabaseFactory = (
	location: string,
	options?: {
		readOnly?: boolean;
	},
) => SqliteDatabase;

type BunSqliteModule = {
	Database: new (
		location: string,
		options?: {
			readonly?: boolean;
		},
	) => SqliteDatabase;
};

type NodeSqliteModule = {
	DatabaseSync: new (
		location: string,
		options?: {
			readOnly?: boolean;
		},
	) => SqliteDatabase;
};

const nodeRequire = createRequire(import.meta.url);
let sqliteDatabaseFactory: SqliteDatabaseFactory | null | undefined;

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

const openCodeDbSessionRowSchema = v.object({
	id: v.string(),
	parent_id: v.nullable(v.string()),
	title: v.nullable(v.string()),
	project_id: v.nullable(v.string()),
	directory: v.nullable(v.string()),
});

const openCodeDbMessageRowSchema = v.object({
	id: v.string(),
	session_id: v.string(),
	data: v.string(),
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
	providerID: string;
	costUSD: number | null;
};

export type LoadedSessionMetadata = {
	id: string;
	parentID: string | null;
	title: string;
	projectID: string;
	directory: string;
};

function isSqliteExperimentalWarning(warning: Error | string): boolean {
	const message = typeof warning === 'string' ? warning : warning.message;
	return message.includes('SQLite is an experimental feature');
}

function loadBunSqliteDatabaseFactory(): SqliteDatabaseFactory | null {
	try {
		const sqlite = nodeRequire('bun:sqlite') as BunSqliteModule;
		return (location, options) =>
			new sqlite.Database(location, {
				readonly: options?.readOnly,
			});
	} catch (error) {
		const code = typeof error === 'object' && error != null && 'code' in error ? error.code : null;

		if (code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && code !== 'MODULE_NOT_FOUND') {
			logger.warn('Failed to load bun:sqlite:', error);
		}

		return null;
	}
}

function loadNodeSqliteDatabaseFactory(): SqliteDatabaseFactory | null {
	const emitWarning = process.emitWarning.bind(process);

	try {
		process.emitWarning = ((warning: Error | string) => {
			if (isSqliteExperimentalWarning(warning)) {
				return;
			}

			return emitWarning(warning);
		}) as typeof process.emitWarning;

		const sqlite = nodeRequire('node:sqlite') as NodeSqliteModule;
		return (location, options) => new sqlite.DatabaseSync(location, options ?? {});
	} catch (error) {
		const code = typeof error === 'object' && error != null && 'code' in error ? error.code : null;

		if (code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && code !== 'MODULE_NOT_FOUND') {
			logger.warn('Failed to load node:sqlite:', error);
		}

		return null;
	} finally {
		process.emitWarning = emitWarning;
	}
}

function getSqliteDatabaseFactory(): SqliteDatabaseFactory | null {
	if (sqliteDatabaseFactory !== undefined) {
		return sqliteDatabaseFactory;
	}

	sqliteDatabaseFactory = loadBunSqliteDatabaseFactory() ?? loadNodeSqliteDatabaseFactory();
	return sqliteDatabaseFactory;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
			return null;
		}

		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function hasBillableTokenUsage(tokens: v.InferOutput<typeof openCodeTokensSchema>): boolean {
	return (
		(tokens.input ?? 0) > 0 ||
		(tokens.output ?? 0) > 0 ||
		(tokens.reasoning ?? 0) > 0 ||
		(tokens.cache?.read ?? 0) > 0 ||
		(tokens.cache?.write ?? 0) > 0
	);
}

function shouldLoadOpenCodeMessage(message: v.InferOutput<typeof openCodeMessageSchema>): boolean {
	if (
		message.tokens?.input == null ||
		message.tokens.output == null ||
		message.tokens.cache?.read == null ||
		message.tokens.cache.write == null ||
		!hasBillableTokenUsage(message.tokens)
	) {
		return false;
	}

	return message.providerID != null && message.modelID != null;
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
		providerID: message.providerID ?? 'unknown',
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

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
	const relativePath = path.relative(directoryPath, targetPath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveOpenCodeDbCandidate(dbPath: string, resolvedOpenCodePath: string): string | null {
	try {
		const resolvedDbPath = realpathSync(dbPath);
		if (!isPathInsideDirectory(resolvedDbPath, resolvedOpenCodePath)) {
			return null;
		}

		return resolvedDbPath;
	} catch {
		return null;
	}
}

function getOpenCodeDbPath(openCodePath: string): string | null {
	let resolvedOpenCodePath: string;
	try {
		resolvedOpenCodePath = realpathSync(openCodePath);
	} catch (error) {
		logger.warn('Failed to resolve OpenCode data directory:', error);
		return null;
	}

	const defaultDbPath = path.join(openCodePath, OPENCODE_DB_FILE_NAME);
	if (existsSync(defaultDbPath)) {
		const resolvedDefaultDbPath = resolveOpenCodeDbCandidate(defaultDbPath, resolvedOpenCodePath);
		if (resolvedDefaultDbPath != null) {
			return resolvedDefaultDbPath;
		}
	}

	let entries: string[];
	try {
		entries = readdirSync(openCodePath);
	} catch (error) {
		logger.warn('Failed to read OpenCode data directory:', error);
		return null;
	}

	for (const entry of entries.filter((name) => OPENCODE_CHANNEL_DB_PATTERN.test(name)).sort()) {
		const resolvedDbPath = resolveOpenCodeDbCandidate(
			path.join(openCodePath, entry),
			resolvedOpenCodePath,
		);
		if (resolvedDbPath != null) {
			return resolvedDbPath;
		}
	}

	return null;
}

function loadOpenCodeSessionsFromDb(openCodePath: string): Map<string, LoadedSessionMetadata> {
	const dbPath = getOpenCodeDbPath(openCodePath);
	if (dbPath == null) {
		return new Map();
	}

	const openSqliteDatabase = getSqliteDatabaseFactory();
	if (openSqliteDatabase == null) {
		return new Map();
	}

	try {
		const db = openSqliteDatabase(dbPath, { readOnly: true });
		try {
			const rows = db
				.prepare('SELECT id, parent_id, title, project_id, directory FROM session')
				.all();

			const sessionMap = new Map<string, LoadedSessionMetadata>();
			for (const rawRow of rows) {
				const parsed = v.safeParse(openCodeDbSessionRowSchema, rawRow);
				if (!parsed.success) {
					continue;
				}

				const row = parsed.output;
				const metadata: LoadedSessionMetadata = {
					id: row.id,
					parentID: row.parent_id,
					title: row.title ?? row.id,
					projectID: row.project_id ?? 'unknown',
					directory: row.directory ?? 'unknown',
				};
				sessionMap.set(metadata.id, metadata);
			}
			return sessionMap;
		} finally {
			db.close();
		}
	} catch (error) {
		logger.warn('Failed to load OpenCode sessions from DB:', error);
		return new Map();
	}
}

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return new Map();
	}

	const sessionMap = loadOpenCodeSessionsFromDb(openCodePath);

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
		if (!sessionMap.has(metadata.id)) {
			sessionMap.set(metadata.id, metadata);
		}
	}

	return sessionMap;
}

function loadOpenCodeMessagesFromDb(openCodePath: string): {
	entries: LoadedUsageEntry[];
	seenIds: Set<string>;
} {
	const dbPath = getOpenCodeDbPath(openCodePath);
	if (dbPath == null) {
		return { entries: [], seenIds: new Set() };
	}

	const openSqliteDatabase = getSqliteDatabaseFactory();
	if (openSqliteDatabase == null) {
		return { entries: [], seenIds: new Set() };
	}

	try {
		const db = openSqliteDatabase(dbPath, { readOnly: true });
		try {
			const rows = db.prepare('SELECT id, session_id, data FROM message').all();

			const entries: LoadedUsageEntry[] = [];
			const seenIds = new Set<string>();

			for (const rawRow of rows) {
				const rowResult = v.safeParse(openCodeDbMessageRowSchema, rawRow);
				if (!rowResult.success) {
					continue;
				}

				const row = rowResult.output;
				const data = parseJsonObject(row.data);
				if (data == null) {
					continue;
				}

				const message = {
					...data,
					id: row.id,
					sessionID: row.session_id,
				};

				const parsed = v.safeParse(openCodeMessageSchema, message);
				if (!parsed.success || !shouldLoadOpenCodeMessage(parsed.output)) {
					continue;
				}

				seenIds.add(parsed.output.id);
				entries.push(convertOpenCodeMessageToUsageEntry(parsed.output));
			}

			return { entries, seenIds };
		} finally {
			db.close();
		}
	} catch (error) {
		logger.warn('Failed to load OpenCode messages from DB:', error);
		return { entries: [], seenIds: new Set() };
	}
}

/**
 * Load all OpenCode messages
 * @returns Array of LoadedUsageEntry for aggregation
 */
export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return [];
	}

	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);

	const { entries, seenIds } = loadOpenCodeMessagesFromDb(openCodePath);

	if (!isDirectorySync(messagesDir)) {
		return entries;
	}

	// Find all message JSON files
	const messageFiles = await glob('**/*.json', {
		cwd: messagesDir,
		absolute: true,
	});

	for (const filePath of messageFiles) {
		const message = await loadOpenCodeMessage(filePath);

		if (message == null) {
			continue;
		}

		if (!shouldLoadOpenCodeMessage(message)) {
			continue;
		}

		// Deduplicate by message ID (DB entries take precedence)
		const dedupeKey = `${message.id}`;
		if (seenIds.has(dedupeKey)) {
			continue;
		}
		seenIds.add(dedupeKey);

		const entry = convertOpenCodeMessageToUsageEntry(message);
		entries.push(entry);
	}

	return entries;
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('data-loader', () => {
		type FixtureValue = FixtureTree | string;

		type FixtureTree = {
			[name: string]: FixtureValue;
		};

		async function writeFixtureTree(baseDir: string, tree: FixtureTree): Promise<void> {
			for (const [name, value] of Object.entries(tree)) {
				const target = path.join(baseDir, name);
				if (typeof value === 'string') {
					await mkdir(path.dirname(target), { recursive: true });
					await writeFile(target, value);
					continue;
				}

				await mkdir(target, { recursive: true });
				await writeFixtureTree(target, value);
			}
		}

		async function createTempFixture(tree: FixtureTree): Promise<{
			getPath: (...segments: string[]) => string;
			path: string;
			[Symbol.asyncDispose]: () => Promise<void>;
		}> {
			const fixturePath = await mkdtemp(path.join(tmpdir(), 'ccusage-opencode-'));
			await writeFixtureTree(fixturePath, tree);

			return {
				path: fixturePath,
				getPath: (...segments) => path.join(fixturePath, ...segments),
				[Symbol.asyncDispose]: async () => rm(fixturePath, { force: true, recursive: true }),
			};
		}

		async function withOpenCodeDataDir<T>(dir: string, callback: () => Promise<T>): Promise<T> {
			const original = process.env[OPENCODE_CONFIG_DIR_ENV];
			process.env[OPENCODE_CONFIG_DIR_ENV] = dir;

			return callback().finally(() => {
				if (original == null) {
					delete process.env[OPENCODE_CONFIG_DIR_ENV];
					return;
				}

				process.env[OPENCODE_CONFIG_DIR_ENV] = original;
			});
		}

		function createOpenCodeDb(dbPath: string): void {
			const openSqliteDatabase = getSqliteDatabaseFactory();
			if (openSqliteDatabase == null) {
				return;
			}

			const db = openSqliteDatabase(dbPath);
			try {
				db.exec(`
					CREATE TABLE session (
						id text PRIMARY KEY,
						project_id text NOT NULL,
						parent_id text,
						directory text NOT NULL,
						title text NOT NULL
					);

					CREATE TABLE message (
						id text PRIMARY KEY,
						session_id text NOT NULL,
						data text NOT NULL
					);
				`);

				db.prepare(
					'INSERT INTO session (id, project_id, parent_id, directory, title) VALUES (?, ?, ?, ?, ?)',
				).run('ses_db', 'project_db', null, '/tmp/project-db', 'DB Session');

				db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
					'msg_db',
					'ses_db',
					JSON.stringify({
						role: 'assistant',
						providerID: 'anthropic',
						modelID: 'claude-sonnet-4-20250514',
						time: {
							created: 1700000000000,
							completed: 1700000010000,
						},
						tokens: {
							input: 10,
							output: 20,
							reasoning: 5,
							cache: {
								read: 30,
								write: 40,
							},
						},
						cost: 0.123,
					}),
				);

				db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
					'msg_bad',
					'ses_db',
					'not json',
				);
			} finally {
				db.close();
			}
		}

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
			expect(entry.providerID).toBe('anthropic');
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
			expect(entry.providerID).toBe('openai');
			expect(entry.costUSD).toBe(null);
		});

		it('should load OpenCode messages and sessions from SQLite', async () => {
			await using fixture = await createTempFixture({});
			createOpenCodeDb(fixture.getPath('opencode.db'));

			await withOpenCodeDataDir(fixture.path, async () => {
				const messages = await loadOpenCodeMessages();
				const sessions = await loadOpenCodeSessions();

				expect(messages).toHaveLength(1);
				expect(messages[0]).toMatchObject({
					sessionID: 'ses_db',
					model: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					costUSD: 0.123,
					usage: {
						inputTokens: 10,
						outputTokens: 20,
						cacheReadInputTokens: 30,
						cacheCreationInputTokens: 40,
					},
				});

				expect(sessions.get('ses_db')).toEqual({
					id: 'ses_db',
					parentID: null,
					title: 'DB Session',
					projectID: 'project_db',
					directory: '/tmp/project-db',
				});
			});
		});

		it('should load OpenCode messages from channel SQLite databases', async () => {
			await using fixture = await createTempFixture({});
			createOpenCodeDb(fixture.getPath('opencode-beta.db'));

			await withOpenCodeDataDir(fixture.path, async () => {
				const messages = await loadOpenCodeMessages();
				const sessions = await loadOpenCodeSessions();

				expect(messages).toHaveLength(1);
				expect(messages[0]?.sessionID).toBe('ses_db');
				expect(sessions.get('ses_db')?.title).toBe('DB Session');
			});
		});

		it('should keep legacy JSON messages that are not present in SQLite', async () => {
			await using fixture = await createTempFixture({
				storage: {
					message: {
						ses_json: {
							'msg_json.json': JSON.stringify({
								id: 'msg_json',
								sessionID: 'ses_json',
								providerID: 'anthropic',
								modelID: 'claude-opus-4-20250514',
								time: {
									created: 1700000020000,
								},
								tokens: {
									input: 111,
									output: 222,
									cache: {
										read: 0,
										write: 0,
									},
								},
							}),
						},
					},
					session: {
						'ses_json.json': JSON.stringify({
							id: 'ses_json',
							title: 'Legacy Session',
							projectID: 'project_json',
							directory: '/tmp/project-json',
						}),
					},
				},
			});
			createOpenCodeDb(fixture.getPath('opencode.db'));

			await withOpenCodeDataDir(fixture.path, async () => {
				const messages = await loadOpenCodeMessages();
				const sessions = await loadOpenCodeSessions();

				expect(messages).toHaveLength(2);
				expect(messages.some((message) => message.sessionID === 'ses_db')).toBe(true);
				expect(messages.some((message) => message.sessionID === 'ses_json')).toBe(true);
				expect(sessions.get('ses_db')?.title).toBe('DB Session');
				expect(sessions.get('ses_json')?.title).toBe('Legacy Session');
			});
		});

		it('should prefer SQLite messages over legacy JSON with the same ID', async () => {
			await using fixture = await createTempFixture({
				storage: {
					message: {
						ses_db: {
							'msg_db.json': JSON.stringify({
								id: 'msg_db',
								sessionID: 'ses_json',
								providerID: 'anthropic',
								modelID: 'claude-opus-4-20250514',
								time: {
									created: 1700000000000,
								},
								tokens: {
									input: 999,
									output: 999,
									cache: {
										read: 0,
										write: 0,
									},
								},
							}),
						},
					},
				},
			});
			createOpenCodeDb(fixture.getPath('opencode.db'));

			await withOpenCodeDataDir(fixture.path, async () => {
				const messages = await loadOpenCodeMessages();

				expect(messages).toHaveLength(1);
				expect(messages[0]?.sessionID).toBe('ses_db');
				expect(messages[0]?.usage.inputTokens).toBe(10);
			});
		});
	});
}
