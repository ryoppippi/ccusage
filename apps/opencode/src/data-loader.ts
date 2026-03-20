/**
 * @fileoverview Data loading utilities for OpenCode usage analysis
 *
 * This module provides functions for loading and parsing OpenCode usage data
 * from the SQLite database stored in ~/.local/share/opencode/opencode.db.
 *
 * @module data-loader
 */

import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import * as v from 'valibot';

/**
 * Default OpenCode data directory path (~/.local/share/opencode)
 */
const DEFAULT_OPENCODE_PATH = '.local/share/opencode';

/**
 * OpenCode database file name
 */
const OPENCODE_DATABASE_FILE_NAME = 'opencode.db';

/**
 * Environment variable for specifying custom OpenCode data directory
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';

/**
 * User home directory
 */
const USER_HOME_DIR = homedir();

const SQLITE_BUSY_TIMEOUT_MS = 5000;
const runtimeRequire = createRequire(import.meta.url);

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
 * Assistant message payload stored in the SQLite message.data column.
 */
export const openCodeMessageSchema = v.object({
	role: v.literal('assistant'),
	providerID: v.string(),
	modelID: modelNameSchema,
	time: v.optional(
		v.object({
			created: v.optional(v.number()),
			completed: v.optional(v.number()),
		}),
	),
	tokens: v.optional(openCodeTokensSchema),
	cost: v.optional(v.number()),
});

export const openCodeSessionSchema = v.object({
	id: sessionIdSchema,
	parent_id: v.nullable(sessionIdSchema),
	title: v.string(),
	project_id: v.string(),
	directory: v.string(),
});

const openCodeMessageRowSchema = v.object({
	id: v.string(),
	session_id: sessionIdSchema,
	time_created: v.number(),
	data: v.string(),
});

type SQLiteStatement<Row extends Record<string, unknown> = Record<string, unknown>> = {
	all: (...params: unknown[]) => Row[];
	get: (...params: unknown[]) => Row | null | undefined;
	run: (...params: unknown[]) => unknown;
};

type SQLiteDatabase = {
	exec: (sql: string) => unknown;
	prepare: <Row extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
	) => SQLiteStatement<Row>;
	close: () => void;
};

/**
 * Represents a single usage data entry loaded from the OpenCode database.
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

const SELECT_OPEN_CODE_MESSAGE_ROWS_SQL = `
	SELECT id, session_id, time_created, data
	FROM message
	ORDER BY time_created ASC
`;

const SELECT_OPEN_CODE_SESSION_ROWS_SQL = `
	SELECT id, parent_id, title, project_id, directory
	FROM session
	ORDER BY time_created ASC
`;

function isBunRuntime(): boolean {
	return (globalThis as Record<string, unknown>).Bun != null;
}

function getPathStats(targetPath: string) {
	return Result.try({
		try: () => statSync(targetPath),
		catch: (error) => error,
	})();
}

function isFile(targetPath: string): boolean {
	const statsResult = getPathStats(targetPath);
	if (Result.isFailure(statsResult)) {
		return false;
	}

	return statsResult.value.isFile();
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

function getOpenCodeDatabasePath(): string | null {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}

	const databasePath = path.join(openCodePath, OPENCODE_DATABASE_FILE_NAME);
	if (!isFile(databasePath)) {
		return null;
	}

	return databasePath;
}

function openSQLiteDatabase(databasePath: string, readOnly: boolean): SQLiteDatabase {
	if (isBunRuntime()) {
		const { Database } = runtimeRequire('bun:sqlite') as {
			Database: new (
				filename: string,
				options?: {
					readonly?: boolean;
					create?: boolean;
				},
			) => SQLiteDatabase;
		};

		return new Database(databasePath, {
			readonly: readOnly,
			create: !readOnly,
		});
	}

	const { DatabaseSync } = runtimeRequire('node:sqlite') as {
		DatabaseSync: new (
			filename: string,
			options?: {
				readOnly?: boolean;
				timeout?: number;
			},
		) => SQLiteDatabase;
	};

	return new DatabaseSync(databasePath, {
		readOnly,
		timeout: SQLITE_BUSY_TIMEOUT_MS,
	});
}

function queryOpenCodeDatabase<Row extends Record<string, unknown>>(sql: string): Row[] {
	const databasePath = getOpenCodeDatabasePath();
	if (databasePath == null) {
		return [];
	}

	const queryResult = Result.try({
		try: () => {
			const database = openSQLiteDatabase(databasePath, true);
			try {
				return database.prepare<Row>(sql).all();
			} finally {
				database.close();
			}
		},
		catch: (error) => error,
	})();

	return Result.unwrap(queryResult, []);
}

function parseOpenCodeMessage(content: string): v.InferOutput<typeof openCodeMessageSchema> | null {
	const parseJSON = Result.try({
		try: () => JSON.parse(content) as unknown,
		catch: (error) => error,
	});
	const parseResult = parseJSON();

	if (Result.isFailure(parseResult)) {
		return null;
	}

	const validationResult = v.safeParse(openCodeMessageSchema, parseResult.value);
	if (!validationResult.success) {
		return null;
	}

	return validationResult.output;
}

function hasUsageTokens(message: v.InferOutput<typeof openCodeMessageSchema>): boolean {
	return (
		(message.tokens?.input ?? 0) > 0 ||
		(message.tokens?.output ?? 0) > 0 ||
		(message.tokens?.cache?.read ?? 0) > 0 ||
		(message.tokens?.cache?.write ?? 0) > 0
	);
}

/**
 * Convert OpenCode message row to LoadedUsageEntry.
 * @param row - Message row from SQLite
 * @returns LoadedUsageEntry suitable for aggregation, or null if invalid
 */
function convertOpenCodeMessageRowToUsageEntry(
	row: v.InferOutput<typeof openCodeMessageRowSchema>,
): LoadedUsageEntry | null {
	const message = parseOpenCodeMessage(row.data);
	if (message == null || !hasUsageTokens(message)) {
		return null;
	}

	const createdMs = message.time?.created ?? row.time_created;

	return {
		timestamp: new Date(createdMs),
		sessionID: row.session_id,
		usage: {
			inputTokens: message.tokens?.input ?? 0,
			outputTokens: message.tokens?.output ?? 0,
			cacheCreationInputTokens: message.tokens?.cache?.write ?? 0,
			cacheReadInputTokens: message.tokens?.cache?.read ?? 0,
		},
		model: message.modelID,
		costUSD: message.cost ?? null,
	};
}

function nonEmptyStringOrFallback(value: string, fallback: string): string {
	return value.trim() === '' ? fallback : value;
}

function convertOpenCodeSessionToMetadata(
	session: v.InferOutput<typeof openCodeSessionSchema>,
): LoadedSessionMetadata {
	return {
		id: session.id,
		parentID: session.parent_id,
		title: nonEmptyStringOrFallback(session.title, session.id),
		projectID: nonEmptyStringOrFallback(session.project_id, 'unknown'),
		directory: nonEmptyStringOrFallback(session.directory, 'unknown'),
	};
}

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const rawRows = queryOpenCodeDatabase<Record<string, unknown>>(SELECT_OPEN_CODE_SESSION_ROWS_SQL);
	const sessionMap = new Map<string, LoadedSessionMetadata>();

	for (const rawRow of rawRows) {
		const validationResult = v.safeParse(openCodeSessionSchema, rawRow);
		if (!validationResult.success) {
			continue;
		}

		const metadata = convertOpenCodeSessionToMetadata(validationResult.output);
		sessionMap.set(metadata.id, metadata);
	}

	return sessionMap;
}

/**
 * Load all OpenCode messages
 * @returns Array of LoadedUsageEntry for aggregation
 */
export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const rawRows = queryOpenCodeDatabase<Record<string, unknown>>(SELECT_OPEN_CODE_MESSAGE_ROWS_SQL);
	const entries: LoadedUsageEntry[] = [];

	for (const rawRow of rawRows) {
		const validationResult = v.safeParse(openCodeMessageRowSchema, rawRow);
		if (!validationResult.success) {
			continue;
		}

		const entry = convertOpenCodeMessageRowToUsageEntry(validationResult.output);
		if (entry == null) {
			continue;
		}

		entries.push(entry);
	}

	return entries;
}

if (import.meta.vitest != null) {
	const { afterEach, describe, expect, it, vi } = import.meta.vitest;

	type TestSessionSeed = {
		id: string;
		parentID?: string | null;
		title: string;
		projectID: string;
		directory: string;
		timeCreated: number;
	};

	type TestMessageSeed = {
		id: string;
		sessionID: string;
		timeCreated: number;
		data: unknown;
	};

	function seedOpenCodeDatabase(
		databasePath: string,
		data: {
			sessions: TestSessionSeed[];
			messages: TestMessageSeed[];
		},
	): void {
		const database = openSQLiteDatabase(databasePath, false);

		try {
			database.exec(`
				CREATE TABLE session (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					parent_id TEXT,
					slug TEXT NOT NULL,
					directory TEXT NOT NULL,
					title TEXT NOT NULL,
					version TEXT NOT NULL,
					share_url TEXT,
					summary_additions INTEGER,
					summary_deletions INTEGER,
					summary_files INTEGER,
					summary_diffs TEXT,
					revert TEXT,
					permission TEXT,
					time_created INTEGER NOT NULL,
					time_updated INTEGER NOT NULL,
					time_compacting INTEGER,
					time_archived INTEGER
				);

				CREATE TABLE message (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					time_created INTEGER NOT NULL,
					time_updated INTEGER NOT NULL,
					data TEXT NOT NULL
				);
			`);

			const insertSession = database.prepare(
				`INSERT INTO session (
					id,
					project_id,
					parent_id,
					slug,
					directory,
					title,
					version,
					time_created,
					time_updated
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const session of data.sessions) {
				insertSession.run(
					session.id,
					session.projectID,
					session.parentID ?? null,
					`${session.id}-slug`,
					session.directory,
					session.title,
					'1.2.0',
					session.timeCreated,
					session.timeCreated,
				);
			}

			const insertMessage = database.prepare(
				'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
			);
			for (const message of data.messages) {
				insertMessage.run(
					message.id,
					message.sessionID,
					message.timeCreated,
					message.timeCreated,
					JSON.stringify(message.data),
				);
			}
		} finally {
			database.close();
		}
	}

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('data-loader', () => {
		it('loads OpenCode usage entries from sqlite messages', async () => {
			await using fixture = await createFixture({});
			seedOpenCodeDatabase(fixture.getPath(OPENCODE_DATABASE_FILE_NAME), {
				sessions: [
					{
						id: 'ses_parent',
						title: 'Parent Session',
						projectID: 'project-1',
						directory: '/repo/project-1',
						timeCreated: 1700000000000,
					},
					{
						id: 'ses_child',
						parentID: 'ses_parent',
						title: 'Child Session',
						projectID: 'project-1',
						directory: '/repo/project-1',
						timeCreated: 1700000001000,
					},
				],
				messages: [
					{
						id: 'msg_valid_1',
						sessionID: 'ses_parent',
						timeCreated: 1700000000000,
						data: {
							role: 'assistant',
							providerID: 'anthropic',
							modelID: 'claude-sonnet-4-5',
							time: { created: 1700000000000 },
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
						},
					},
					{
						id: 'msg_user',
						sessionID: 'ses_parent',
						timeCreated: 1700000000100,
						data: {
							role: 'user',
							agent: 'general',
							model: {
								providerID: 'anthropic',
								modelID: 'claude-sonnet-4-5',
							},
						},
					},
					{
						id: 'msg_zero_tokens',
						sessionID: 'ses_parent',
						timeCreated: 1700000000200,
						data: {
							role: 'assistant',
							providerID: 'anthropic',
							modelID: 'claude-sonnet-4-5',
							tokens: {
								input: 0,
								output: 0,
								reasoning: 0,
								cache: {
									read: 0,
									write: 0,
								},
							},
						},
					},
					{
						id: 'msg_missing_model',
						sessionID: 'ses_child',
						timeCreated: 1700000000300,
						data: {
							role: 'assistant',
							providerID: 'anthropic',
							tokens: {
								input: 10,
								output: 20,
								reasoning: 0,
								cache: {
									read: 0,
									write: 0,
								},
							},
						},
					},
					{
						id: 'msg_valid_2',
						sessionID: 'ses_child',
						timeCreated: 1700000001000,
						data: {
							role: 'assistant',
							providerID: 'anthropic',
							modelID: 'claude-opus-4-20250514',
							tokens: {
								input: 300,
								output: 400,
								reasoning: 0,
								cache: {
									read: 100,
									write: 75,
								},
							},
						},
					},
				],
			});

			vi.stubEnv(OPENCODE_CONFIG_DIR_ENV, fixture.path);

			const entries = await loadOpenCodeMessages();

			expect(entries).toHaveLength(2);
			expect(entries[0]).toEqual({
				timestamp: new Date(1700000000000),
				sessionID: 'ses_parent',
				usage: {
					inputTokens: 100,
					outputTokens: 200,
					cacheCreationInputTokens: 25,
					cacheReadInputTokens: 50,
				},
				model: 'claude-sonnet-4-5',
				costUSD: 0.001,
			});
			expect(entries[1]).toEqual({
				timestamp: new Date(1700000001000),
				sessionID: 'ses_child',
				usage: {
					inputTokens: 300,
					outputTokens: 400,
					cacheCreationInputTokens: 75,
					cacheReadInputTokens: 100,
				},
				model: 'claude-opus-4-20250514',
				costUSD: null,
			});
		});

		it('loads OpenCode session metadata from sqlite sessions', async () => {
			await using fixture = await createFixture({});
			seedOpenCodeDatabase(fixture.getPath(OPENCODE_DATABASE_FILE_NAME), {
				sessions: [
					{
						id: 'ses_parent',
						title: 'Parent Session',
						projectID: 'project-1',
						directory: '/repo/project-1',
						timeCreated: 1700000000000,
					},
					{
						id: 'ses_child',
						parentID: 'ses_parent',
						title: '',
						projectID: '',
						directory: '',
						timeCreated: 1700000001000,
					},
				],
				messages: [],
			});

			vi.stubEnv(OPENCODE_CONFIG_DIR_ENV, fixture.path);

			const sessions = await loadOpenCodeSessions();

			expect(sessions.size).toBe(2);
			expect(sessions.get('ses_parent')).toEqual({
				id: 'ses_parent',
				parentID: null,
				title: 'Parent Session',
				projectID: 'project-1',
				directory: '/repo/project-1',
			});
			expect(sessions.get('ses_child')).toEqual({
				id: 'ses_child',
				parentID: 'ses_parent',
				title: 'ses_child',
				projectID: 'unknown',
				directory: 'unknown',
			});
		});
	});
}
