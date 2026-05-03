import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { isDirectorySync } from 'path-type';
import { logger } from './logger.ts';

const DEFAULT_HERMES_PATH = '.hermes';
const HERMES_STATE_DB = 'state.db';
const HERMES_CONFIG_DIR_ENV = 'HERMES_DATA_DIR';

/**
 * Resolve the Hermes data directory.
 * 1. Check HERMES_DATA_DIR env var
 * 2. Fallback to ~/.hermes
 */
function getHermesPath(): string | null {
	const envPath = process.env[HERMES_CONFIG_DIR_ENV]?.trim();
	if (envPath != null && envPath !== '' && isDirectorySync(envPath)) {
		return path.resolve(envPath);
	}

	const defaultPath = path.join(homedir(), DEFAULT_HERMES_PATH);
	if (isDirectorySync(defaultPath)) {
		return defaultPath;
	}

	return null;
}

function getStateDbPath(): string | null {
	const hermesPath = getHermesPath();
	if (hermesPath == null) return null;
	return path.join(hermesPath, HERMES_STATE_DB);
}

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
};

function safeNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'string') return Number.parseFloat(value);
	return 0;
}

function safeString(value: unknown): string | null {
	if (typeof value === 'string') return value;
	return null;
}

/**
 * Normalize Hermes model names for LiteLLM pricing lookup.
 * - Replace spaces with dashes
 * - Strip provider prefixes (antigravity/, opencode-go/, kiro/, etc.)
 */
function normalizeModelName(raw: string): string {
	let model = raw.trim().replace(/\s+/g, '-');
	// Strip known provider prefixes
	const prefixes = ['antigravity/', 'opencode-go/', 'kiro/', 'nous/', 'openrouter/'];
	for (const prefix of prefixes) {
		if (model.startsWith(prefix)) {
			model = model.slice(prefix.length);
			break;
		}
	}
	return model;
}

/**
 * Load usage entries from Hermes SQLite database.
 * Each session row becomes one usage entry with aggregated token counts.
 */
export function loadHermesSessions(): LoadedUsageEntry[] {
	const dbPath = getStateDbPath();
	if (dbPath == null) {
		logger.warn('Hermes data directory not found. Set HERMES_DATA_DIR or ensure ~/.hermes exists.');
		return [];
	}

	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch (err) {
		logger.warn(`Failed to open Hermes database at ${dbPath}:`, err);
		return [];
	}

	try {
		const stmt = db.prepare(`
			SELECT
				id,
				started_at,
				model,
				input_tokens,
				output_tokens,
				cache_read_tokens,
				cache_write_tokens,
				estimated_cost_usd,
				actual_cost_usd
			FROM sessions
			WHERE started_at IS NOT NULL
				AND (input_tokens > 0 OR output_tokens > 0)
			ORDER BY started_at ASC
		`);

		const rows = stmt.all() as Array<Record<string, unknown>>;
		const entries: LoadedUsageEntry[] = [];
		const seen = new Set<string>();

		for (const row of rows) {
			const sessionID = safeString(row.id);
			if (sessionID == null) continue;

			// Deduplicate by session ID
			if (seen.has(sessionID)) continue;
			seen.add(sessionID);

			const startedAt = safeNumber(row.started_at);
			const timestamp = new Date(startedAt * 1000);

			const rawModel = safeString(row.model);
			const model = rawModel != null ? normalizeModelName(rawModel) : 'unknown';

			const actualCost = safeNumber(row.actual_cost_usd);
			const estimatedCost = safeNumber(row.estimated_cost_usd);
			const costUSD = actualCost > 0 ? actualCost : estimatedCost > 0 ? estimatedCost : null;

			entries.push({
				timestamp,
				sessionID,
				usage: {
					inputTokens: safeNumber(row.input_tokens),
					outputTokens: safeNumber(row.output_tokens),
					cacheCreationInputTokens: safeNumber(row.cache_write_tokens),
					cacheReadInputTokens: safeNumber(row.cache_read_tokens),
				},
				model,
				costUSD,
			});
		}

		return entries;
	} catch (err) {
		logger.warn('Failed to query Hermes sessions:', err);
		return [];
	} finally {
		try {
			db.close();
		} catch {
			// ignore close errors
		}
	}
}

/**
 * Load session metadata from Hermes SQLite database.
 * Returns a Map keyed by session ID.
 */
export function loadHermesSessionMetadata(): Map<string, LoadedSessionMetadata> {
	const dbPath = getStateDbPath();
	if (dbPath == null) {
		return new Map();
	}

	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return new Map();
	}

	try {
		const stmt = db.prepare(`
			SELECT
				id,
				parent_session_id,
				title
			FROM sessions
			WHERE id IS NOT NULL
		`);

		const rows = stmt.all() as Array<Record<string, unknown>>;
		const map = new Map<string, LoadedSessionMetadata>();

		for (const row of rows) {
			const id = safeString(row.id);
			if (id == null) continue;

			map.set(id, {
				id,
				parentID: safeString(row.parent_session_id),
				title: safeString(row.title) ?? id,
			});
		}

		return map;
	} catch {
		return new Map();
	} finally {
		try {
			db.close();
		} catch {
			// ignore
		}
	}
}
