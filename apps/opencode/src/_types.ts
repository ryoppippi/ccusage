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
	prepareAll: (sql: string) => Array<Record<string, unknown>>;
	close: () => void;
};

export type BetterSqlite3 = typeof import('better-sqlite3');
