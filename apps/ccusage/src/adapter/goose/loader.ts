import type { GooseSessionRow, GooseUsageEntry } from './schema.ts';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import { logger } from '../../logger.ts';
import { getGooseDbPaths } from './paths.ts';
import { gooseSessionRowSchema, parseGooseModelConfig } from './schema.ts';

const GOOSE_SESSION_QUERY = `
SELECT
	id,
	model_config_json,
	provider_name,
	created_at,
	total_tokens,
	input_tokens,
	output_tokens,
	accumulated_total_tokens,
	accumulated_input_tokens,
	accumulated_output_tokens
FROM sessions
WHERE model_config_json IS NOT NULL
	AND TRIM(model_config_json) != ''
`;

function parseSqliteTimestamp(value: string): Date | null {
	const sqliteTimestamp = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value);
	if (sqliteTimestamp != null) {
		const [, year, month, day, hour, minute, second] = sqliteTimestamp;
		const timestamp = Date.UTC(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
		);
		return Number.isFinite(timestamp) ? new Date(timestamp) : null;
	}

	const sqliteDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (sqliteDate != null) {
		const [, year, month, day] = sqliteDate;
		const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
		return Number.isFinite(timestamp) ? new Date(timestamp) : null;
	}

	return null;
}

function parseTimestamp(value: string | number): Date | null {
	if (typeof value === 'number') {
		const timestamp = value > 1e12 ? value : value * 1000;
		return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null;
	}

	const trimmed = value.trim();
	if (trimmed === '') {
		return null;
	}
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		return parseTimestamp(numeric);
	}

	const sqliteTimestamp = parseSqliteTimestamp(trimmed);
	if (sqliteTimestamp != null) {
		return sqliteTimestamp;
	}

	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed) : null;
}

function normalizeProvider(provider: string | null | undefined, model: string): string {
	const trimmed = provider?.trim();
	if (trimmed != null && trimmed !== '') {
		return trimmed.replaceAll('-', '_');
	}
	if (model.startsWith('claude-')) {
		return 'anthropic';
	}
	if (/^(?:gpt-|o\d|chatgpt-)/u.test(model)) {
		return 'openai';
	}
	if (model.startsWith('gemini-')) {
		return 'google';
	}
	if (/^qwen/i.test(model)) {
		return 'openrouter';
	}
	return 'goose';
}

function toGooseUsageEntry(row: GooseSessionRow): GooseUsageEntry | null {
	const modelConfig = row.model_config_json;
	if (modelConfig == null) {
		return null;
	}
	const model = parseGooseModelConfig(modelConfig);
	const timestamp = parseTimestamp(row.created_at);
	if (model == null || timestamp == null) {
		return null;
	}

	const inputTokens = Math.max(row.accumulated_input_tokens ?? row.input_tokens ?? 0, 0);
	const outputTokens = Math.max(row.accumulated_output_tokens ?? row.output_tokens ?? 0, 0);
	const totalTokens = Math.max(
		row.accumulated_total_tokens ?? row.total_tokens ?? inputTokens + outputTokens,
		0,
	);
	if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
		return null;
	}

	return {
		timestamp,
		sessionID: row.id,
		model,
		providerID: normalizeProvider(row.provider_name, model),
		inputTokens,
		outputTokens,
		reasoningTokens: Math.max(totalTokens - inputTokens - outputTokens, 0),
		totalTokens,
	};
}

export function loadGooseEntriesFromDb(dbPath: string): GooseUsageEntry[] {
	if (getSqliteDatabaseFactory(logger.warn) == null) {
		return [];
	}

	const result = Result.try({
		try: () =>
			withSqliteDatabase(
				dbPath,
				{ readOnly: true },
				(db) =>
					db
						.prepare(GOOSE_SESSION_QUERY)
						.all()
						.flatMap((rawRow) => {
							const row = v.safeParse(gooseSessionRowSchema, rawRow);
							if (!row.success) {
								return [];
							}
							const entry = toGooseUsageEntry(row.output);
							return entry == null ? [] : [entry];
						}),
				logger.warn,
			),
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		logger.warn('Failed to load Goose sessions database:', result.error);
		return [];
	}
	return result.value ?? [];
}

export async function loadGooseEntries(): Promise<GooseUsageEntry[]> {
	const entries: GooseUsageEntry[] = [];
	const seen = new Set<string>();
	for (const dbPath of getGooseDbPaths()) {
		for (const entry of loadGooseEntriesFromDb(dbPath)) {
			const key = `${dbPath}:${entry.sessionID}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			entries.push(entry);
		}
	}
	return entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

if (import.meta.vitest != null) {
	describe('loadGooseEntriesFromDb', () => {
		function createGooseDb(dbPath: string): void {
			withSqliteDatabase(
				dbPath,
				{},
				(db) => {
					db.exec(`
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	model_config_json TEXT,
	provider_name TEXT,
	created_at TEXT,
	total_tokens INTEGER,
	input_tokens INTEGER,
	output_tokens INTEGER,
	accumulated_total_tokens INTEGER,
	accumulated_input_tokens INTEGER,
	accumulated_output_tokens INTEGER
)
`);
				},
				logger.warn,
			);
		}

		function insertSession(
			dbPath: string,
			values: {
				id: string;
				modelConfig: string | null;
				providerName?: string | null;
				createdAt: string;
				total?: number | null;
				input?: number | null;
				output?: number | null;
				accumulatedTotal?: number | null;
				accumulatedInput?: number | null;
				accumulatedOutput?: number | null;
			},
		): void {
			withSqliteDatabase(
				dbPath,
				{},
				(db) => {
					db.prepare(
						`INSERT INTO sessions (
	id,
	model_config_json,
	provider_name,
	created_at,
	total_tokens,
	input_tokens,
	output_tokens,
	accumulated_total_tokens,
	accumulated_input_tokens,
	accumulated_output_tokens
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						values.id,
						values.modelConfig,
						values.providerName ?? null,
						values.createdAt,
						values.total ?? null,
						values.input ?? null,
						values.output ?? null,
						values.accumulatedTotal ?? null,
						values.accumulatedInput ?? null,
						values.accumulatedOutput ?? null,
					);
				},
				logger.warn,
			);
		}

		it('loads accumulated token counts from Goose sessions SQLite', async () => {
			await using fixture = await createFixture({
				sessions: {},
			});
			const dbPath = fixture.getPath('sessions/sessions.db');
			createGooseDb(dbPath);
			insertSession(dbPath, {
				id: 'session-a',
				modelConfig: '{"model_name":"claude-sonnet-4-20250514"}',
				providerName: 'anthropic',
				createdAt: '2026-05-01 01:02:03',
				total: 999,
				input: 1,
				output: 2,
				accumulatedTotal: 180,
				accumulatedInput: 100,
				accumulatedOutput: 50,
			});

			expect(loadGooseEntriesFromDb(dbPath)).toEqual([
				{
					timestamp: new Date('2026-05-01T01:02:03.000Z'),
					sessionID: 'session-a',
					model: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					inputTokens: 100,
					outputTokens: 50,
					reasoningTokens: 30,
					totalTokens: 180,
				},
			]);
		});

		it('skips invalid rows and zero-token sessions', async () => {
			await using fixture = await createFixture({
				sessions: {},
			});
			const dbPath = fixture.getPath('sessions/sessions.db');
			createGooseDb(dbPath);
			insertSession(dbPath, {
				id: 'zero',
				modelConfig: '{"model_name":"claude-sonnet-4-20250514"}',
				createdAt: '2026-05-01T01:02:03Z',
				total: 0,
				input: 0,
				output: 0,
			});
			insertSession(dbPath, {
				id: 'invalid-model',
				modelConfig: '{"model_name":"  "}',
				createdAt: '2026-05-01T01:02:03Z',
				total: 10,
			});
			insertSession(dbPath, {
				id: 'invalid-time',
				modelConfig: '{"model_name":"gpt-5"}',
				createdAt: 'not a date',
				total: 10,
			});

			expect(loadGooseEntriesFromDb(dbPath)).toEqual([]);
		});
	});
}
