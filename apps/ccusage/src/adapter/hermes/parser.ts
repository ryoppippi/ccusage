import path from 'node:path';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { createFixture } from 'fs-fixture';
import { loadReadonlySqliteRows } from '../sqlite.ts';
import { getHermesStateDbPaths } from './paths.ts';

export type HermesUsageEntry = {
	timestamp: string;
	sessionId: string;
	model: string;
	provider: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	messageCount: number;
	costUSD: number | null;
};

type HermesSessionRow = {
	id: unknown;
	model: unknown;
	billing_provider: unknown;
	started_at: unknown;
	message_count: unknown;
	input_tokens: unknown;
	output_tokens: unknown;
	cache_read_tokens: unknown;
	cache_write_tokens: unknown;
	reasoning_tokens: unknown;
	estimated_cost_usd: unknown;
	actual_cost_usd: unknown;
};

const PROVIDER_ALIASES = new Map<string, string>([
	['anthropic', 'anthropic'],
	['claude', 'anthropic'],
	['openai', 'openai'],
	['openai_codex', 'openai'],
	['google', 'google'],
	['google_ai', 'google'],
	['gemini', 'google'],
	['vertex', 'google'],
	['vertex_ai', 'google'],
	['openrouter', 'openrouter'],
	['xai', 'xai'],
	['groq', 'groq'],
]);

function toNumber(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	return null;
}

function toNonNegativeInteger(value: unknown): number {
	return Math.max(Math.trunc(toNumber(value) ?? 0), 0);
}

function toNonNegativeNumber(value: unknown): number | null {
	const number = toNumber(value);
	return number == null ? null : Math.max(number, 0);
}

function timestampToIsoString(value: unknown): string | null {
	const timestamp = toNumber(value);
	if (timestamp == null) {
		return null;
	}
	const milliseconds = timestamp > 1e12 ? timestamp : timestamp * 1000;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inferProviderFromModel(model: string): string {
	if (/^claude[-/]/u.test(model)) {
		return 'anthropic';
	}
	if (/^(?:gpt|chatgpt)(?:[-/]|$)|^o\d(?:[-/]|$)/u.test(model)) {
		return 'openai';
	}
	if (/^gemini[-/]/u.test(model)) {
		return 'google';
	}
	return 'hermes';
}

function normalizeProvider(value: unknown, model: string): string {
	if (typeof value === 'string' && value.trim() !== '') {
		const normalized = value.trim().toLowerCase().replaceAll('-', '_');
		const provider = PROVIDER_ALIASES.get(normalized);
		if (provider != null) {
			return provider;
		}
	}
	return inferProviderFromModel(model);
}

function parseHermesSessionRow(row: HermesSessionRow): HermesUsageEntry | null {
	if (typeof row.id !== 'string' || typeof row.model !== 'string' || row.model.trim() === '') {
		return null;
	}
	const timestamp = timestampToIsoString(row.started_at);
	if (timestamp == null) {
		return null;
	}

	const inputTokens = toNonNegativeInteger(row.input_tokens);
	const outputTokens = toNonNegativeInteger(row.output_tokens);
	const cacheReadTokens = toNonNegativeInteger(row.cache_read_tokens);
	const cacheCreationTokens = toNonNegativeInteger(row.cache_write_tokens);
	const reasoningTokens = toNonNegativeInteger(row.reasoning_tokens);
	const costUSD =
		toNonNegativeNumber(row.actual_cost_usd) ?? toNonNegativeNumber(row.estimated_cost_usd);
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheReadTokens === 0 &&
		cacheCreationTokens === 0 &&
		reasoningTokens === 0 &&
		(costUSD ?? 0) === 0
	) {
		return null;
	}

	const model = row.model.trim();
	return {
		timestamp,
		sessionId: row.id,
		model,
		provider: normalizeProvider(row.billing_provider, model),
		inputTokens,
		outputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		reasoningTokens,
		messageCount: toNonNegativeInteger(row.message_count),
		costUSD,
	};
}

function loadHermesStateDbEntries(dbPath: string): HermesUsageEntry[] {
	return loadReadonlySqliteRows(dbPath, 'Failed to load Hermes Agent state database:', (db) => {
		const rows = db
			.prepare(`
				SELECT
					id,
					model,
					billing_provider,
					started_at,
					message_count,
					input_tokens,
					output_tokens,
					cache_read_tokens,
					cache_write_tokens,
					reasoning_tokens,
					estimated_cost_usd,
					actual_cost_usd
				FROM sessions
				WHERE model IS NOT NULL
					AND TRIM(model) != ''
			`)
			.all() as HermesSessionRow[];
		return rows.flatMap((row) => {
			const entry = parseHermesSessionRow(row);
			return entry == null ? [] : [entry];
		});
	});
}

export function loadHermesUsageEntries(_dbPaths?: string[]): HermesUsageEntry[] {
	const dbPaths = _dbPaths ?? getHermesStateDbPaths();
	const entries: HermesUsageEntry[] = [];
	const seenSessions = new Set<string>();
	for (const dbPath of dbPaths) {
		for (const entry of loadHermesStateDbEntries(dbPath)) {
			if (seenSessions.has(entry.sessionId)) {
				continue;
			}
			seenSessions.add(entry.sessionId);
			entries.push(entry);
		}
	}
	return entries;
}

if (import.meta.vitest != null) {
	function createHermesStateDb(dbPath: string): void {
		const result = withSqliteDatabase(
			dbPath,
			{},
			(db) => {
				db.exec(`
					CREATE TABLE sessions (
						id TEXT PRIMARY KEY,
						source TEXT NOT NULL,
						model TEXT,
						started_at REAL NOT NULL,
						message_count INTEGER DEFAULT 0,
						input_tokens INTEGER DEFAULT 0,
						output_tokens INTEGER DEFAULT 0,
						cache_read_tokens INTEGER DEFAULT 0,
						cache_write_tokens INTEGER DEFAULT 0,
						reasoning_tokens INTEGER DEFAULT 0,
						billing_provider TEXT,
						estimated_cost_usd REAL,
						actual_cost_usd REAL
					);
				`);
			},
			() => {},
		);
		expect(result).not.toBeNull();
	}

	describe('loadHermesUsageEntries', () => {
		it.skipIf(getSqliteDatabaseFactory(() => {}) == null)(
			'loads billable Hermes sessions from state.db',
			async () => {
				await using fixture = await createFixture({});
				const dbPath = path.join(fixture.path, 'state.db');
				createHermesStateDb(dbPath);

				withSqliteDatabase(
					dbPath,
					{},
					(db) => {
						db.prepare(`
							INSERT INTO sessions (
								id, source, model, started_at, message_count,
								input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
								billing_provider, estimated_cost_usd, actual_cost_usd
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						`).run(
							'session-1',
							'cli',
							'claude-sonnet-4-20250514',
							1_750_000_000.25,
							42,
							1200,
							300,
							50,
							20,
							10,
							'anthropic',
							0.12,
							0.34,
						);
					},
					() => {},
				);

				expect(loadHermesUsageEntries([dbPath])).toEqual([
					{
						timestamp: '2025-06-15T15:06:40.250Z',
						sessionId: 'session-1',
						model: 'claude-sonnet-4-20250514',
						provider: 'anthropic',
						inputTokens: 1200,
						outputTokens: 300,
						cacheCreationTokens: 20,
						cacheReadTokens: 50,
						reasoningTokens: 10,
						messageCount: 42,
						costUSD: 0.34,
					},
				]);
			},
		);

		it.skipIf(getSqliteDatabaseFactory(() => {}) == null)(
			'falls back to model provider inference when billing provider is unknown',
			async () => {
				await using fixture = await createFixture({});
				const dbPath = path.join(fixture.path, 'state.db');
				createHermesStateDb(dbPath);

				withSqliteDatabase(
					dbPath,
					{},
					(db) => {
						db.prepare(`
							INSERT INTO sessions (
								id, source, model, started_at, message_count,
								input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
								billing_provider, estimated_cost_usd, actual_cost_usd
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						`).run(
							'session-unknown-provider',
							'cli',
							'gpt-5.4',
							1_775_001_105.0,
							2,
							100,
							20,
							0,
							0,
							0,
							'unknown',
							0.5,
							null,
						);
					},
					() => {},
				);

				expect(loadHermesUsageEntries([dbPath])[0]?.provider).toBe('openai');
			},
		);

		it.skipIf(getSqliteDatabaseFactory(() => {}) == null)(
			'keeps missing recorded cost distinct from a recorded zero cost',
			async () => {
				await using fixture = await createFixture({});
				const dbPath = path.join(fixture.path, 'state.db');
				createHermesStateDb(dbPath);

				withSqliteDatabase(
					dbPath,
					{},
					(db) => {
						const insert = db.prepare(`
								INSERT INTO sessions (
									id, source, model, started_at, message_count,
									input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
									billing_provider, estimated_cost_usd, actual_cost_usd
								) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							`);
						insert.run(
							'session-free',
							'cli',
							'gpt-5.4',
							1_775_001_105.0,
							1,
							100,
							20,
							0,
							0,
							0,
							'openai',
							null,
							0,
						);
						insert.run(
							'session-missing-cost',
							'cli',
							'gpt-5.4',
							1_775_001_106.0,
							1,
							100,
							20,
							0,
							0,
							0,
							'openai',
							null,
							null,
						);
					},
					() => {},
				);

				expect(loadHermesUsageEntries([dbPath])).toMatchObject([
					{ sessionId: 'session-free', costUSD: 0 },
					{ sessionId: 'session-missing-cost', costUSD: null },
				]);
			},
		);
	});
}
