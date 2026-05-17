import { createRequire } from 'node:module';
import process from 'node:process';

export type SqliteStatement = {
	all: (...params: unknown[]) => unknown[];
	run: (...params: unknown[]) => unknown;
};

export type SqliteDatabase = {
	close: () => void;
	exec: (sql: string) => unknown;
	prepare: (sql: string) => SqliteStatement;
};

export type SqliteDatabaseFactory = (
	location: string,
	options?: {
		readOnly?: boolean;
	},
) => SqliteDatabase;

export type SqliteWarningLogger = (...args: unknown[]) => void;

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

function getErrorCode(error: unknown): unknown {
	return typeof error === 'object' && error != null && 'code' in error ? error.code : null;
}

function isMissingSqliteModule(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === 'ERR_UNKNOWN_BUILTIN_MODULE' || code === 'MODULE_NOT_FOUND';
}

export function isSqliteExperimentalWarning(warning: Error | string): boolean {
	const message = typeof warning === 'string' ? warning : warning.message;
	return message.includes('SQLite is an experimental feature');
}

function loadBunSqliteDatabaseFactory(warn?: SqliteWarningLogger): SqliteDatabaseFactory | null {
	try {
		const sqlite = nodeRequire('bun:sqlite') as BunSqliteModule;
		return (location, options) =>
			new sqlite.Database(location, {
				readonly: options?.readOnly,
			});
	} catch (error) {
		if (!isMissingSqliteModule(error)) {
			warn?.('Failed to load bun:sqlite:', error);
		}

		return null;
	}
}

function loadNodeSqliteDatabaseFactory(warn?: SqliteWarningLogger): SqliteDatabaseFactory | null {
	const emitWarning = process.emitWarning.bind(process);

	try {
		process.emitWarning = ((warning: Error | string, ...args: unknown[]) => {
			if (isSqliteExperimentalWarning(warning)) {
				return;
			}

			return (emitWarning as (warning: Error | string, ...args: unknown[]) => void)(
				warning,
				...args,
			);
		}) as typeof process.emitWarning;

		const sqlite = nodeRequire('node:sqlite') as NodeSqliteModule;
		return (location, options) => new sqlite.DatabaseSync(location, options ?? {});
	} catch (error) {
		if (!isMissingSqliteModule(error)) {
			warn?.('Failed to load node:sqlite:', error);
		}

		return null;
	} finally {
		process.emitWarning = emitWarning;
	}
}

export function getSqliteDatabaseFactory(warn?: SqliteWarningLogger): SqliteDatabaseFactory | null {
	if (sqliteDatabaseFactory !== undefined) {
		return sqliteDatabaseFactory;
	}

	sqliteDatabaseFactory = loadBunSqliteDatabaseFactory(warn) ?? loadNodeSqliteDatabaseFactory(warn);
	return sqliteDatabaseFactory;
}

export function withSqliteDatabase<T>(
	location: string,
	options: {
		readOnly?: boolean;
	},
	callback: (db: SqliteDatabase) => T,
	warn?: SqliteWarningLogger,
): T | null {
	const openSqliteDatabase = getSqliteDatabaseFactory(warn);
	if (openSqliteDatabase == null) {
		return null;
	}

	const db = openSqliteDatabase(location, options);
	try {
		return callback(db);
	} finally {
		db.close();
	}
}

if (import.meta.vitest != null) {
	describe('isSqliteExperimentalWarning', () => {
		it('matches node sqlite experimental warnings', () => {
			expect(isSqliteExperimentalWarning('SQLite is an experimental feature')).toBe(true);
		});

		it('ignores unrelated warnings', () => {
			expect(isSqliteExperimentalWarning('different warning')).toBe(false);
		});
	});
}
