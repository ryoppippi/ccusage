import * as v from "valibot";

export const modelNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Model name cannot be empty"),
  v.brand("ModelName"),
);

export const sessionIdSchema = v.pipe(
  v.string(),
  v.minLength(1, "Session ID cannot be empty"),
  v.brand("SessionId"),
);

export type ModelName = v.InferOutput<typeof modelNameSchema>;
export type SessionId = v.InferOutput<typeof sessionIdSchema>;

/** Creates a branded ModelName from a raw string, throwing on invalid input. */
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
/** Creates a branded SessionId from a raw string, throwing on invalid input. */
export const createSessionId = (value: string): SessionId => v.parse(sessionIdSchema, value);

/**
 * A usage entry loaded from OpenCode data sources (SQLite or JSON files).
 * costUSD is null when pre-calculated cost is unavailable.
 * model defaults to 'unknown' when not specified in the source data.
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

/**
 * Metadata for an OpenCode session. parentID is null for root sessions (no parent).
 * title defaults to the session id when absent; projectID and directory default to 'unknown'.
 */
export type LoadedSessionMetadata = {
  id: string;
  parentID: string | null;
  title: string;
  projectID: string;
  directory: string;
};

/** Raw database row from the OpenCode message table. `data` is a JSON-encoded string that must be parsed before use; `time_created` is a Unix timestamp in milliseconds. */
export type DbMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
};

/** Raw database row from the OpenCode session table. parent_id is null for root sessions. */
export type DbSessionRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  directory: string;
};

/**
 * Result of loading data from the OpenCode SQLite database.
 * dbMessageIds and dbSessionIds are sets used for deduplication with legacy file data.
 * dbSessionMap maps session IDs to their metadata.
 */
export type DbResult = {
  dbEntries: LoadedUsageEntry[];
  dbSessionMap: Map<string, LoadedSessionMetadata>;
  dbMessageIds: Set<string>;
  dbSessionIds: Set<string>;
};

/**
 * Adapter interface abstracting over better-sqlite3 (Node) and bun:sqlite (Bun) runtimes.
 * Implementations must provide prepareAll for query execution and close for cleanup.
 */
export type SqliteAdapter = {
  prepareAll: <T>(sql: string) => Array<T>;
  close: () => void;
};

export type BetterSqlite3 = typeof import("better-sqlite3");
