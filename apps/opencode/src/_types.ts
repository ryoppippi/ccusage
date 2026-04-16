import * as v from 'valibot';

export const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);

export const sessionIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Session ID cannot be empty'),
	v.brand('SessionId'),
);

export type ModelName = v.InferOutput<typeof modelNameSchema>;
export type SessionId = v.InferOutput<typeof sessionIdSchema>;

export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
export const createSessionId = (value: string): SessionId => v.parse(sessionIdSchema, value);

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

export type DbMessageRow = {
	id: string;
	session_id: string;
	time_created: number;
	data: string;
};

export type DbSessionRow = {
	id: string;
	project_id: string;
	parent_id: string | null;
	title: string;
	directory: string;
};

export type DbResult = {
	dbEntries: LoadedUsageEntry[];
	dbSessionMap: Map<string, LoadedSessionMetadata>;
	dbMessageIds: Set<string>;
	dbSessionIds: Set<string>;
};

export type SqliteAdapter = {
	prepareAll: <T>(sql: string) => Array<T>;
	close: () => void;
};

export type BetterSqlite3 = typeof import('better-sqlite3');
