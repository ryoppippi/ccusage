import type { KiloMessage, KiloMessageResult, KiloTokens, KiloUsageEntry } from './schema.ts';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import { logger } from '../../logger.ts';
import { getKiloDbPath, getKiloPaths } from './paths.ts';
import { kiloDbMessageRowSchema, kiloMessageSchema } from './schema.ts';

function parseJsonObject(value: string): Record<string, unknown> | null {
	const result = Result.try({
		try: () => JSON.parse(value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		return null;
	}
	if (typeof result.value !== 'object' || result.value == null || Array.isArray(result.value)) {
		return null;
	}
	return result.value as Record<string, unknown>;
}

function hasBillableTokenUsage(tokens: KiloTokens): boolean {
	return (
		tokens.input > 0 ||
		tokens.output > 0 ||
		(tokens.reasoning ?? 0) > 0 ||
		tokens.cache.read > 0 ||
		tokens.cache.write > 0
	);
}

function shouldLoadKiloMessage(message: KiloMessage): boolean {
	return (
		message.role === 'assistant' &&
		message.tokens != null &&
		hasBillableTokenUsage(message.tokens) &&
		message.modelID != null
	);
}

function normalizeTimestamp(value: number | undefined): number | null {
	if (value == null || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return value < 1_000_000_000_000 ? value * 1000 : value;
}

function convertKiloMessageToUsageEntry(
	message: KiloMessage,
	rowSessionId: string,
): KiloUsageEntry | null {
	const tokens = message.tokens;
	const timestamp = normalizeTimestamp(message.time?.created);
	if (timestamp == null) {
		return null;
	}
	return {
		timestamp: new Date(timestamp),
		sessionID: message.session_id ?? rowSessionId,
		usage: {
			inputTokens: tokens?.input ?? 0,
			outputTokens: tokens?.output ?? 0,
			cacheCreationInputTokens: tokens?.cache.write ?? 0,
			cacheReadInputTokens: tokens?.cache.read ?? 0,
			reasoningTokens: tokens?.reasoning ?? 0,
		},
		model: message.modelID ?? 'unknown',
		providerID: message.providerID ?? 'unknown',
		costUSD: message.cost ?? null,
		agent: message.agent ?? message.mode ?? null,
	};
}

function parseKiloMessageRecord(
	value: unknown,
	rowId: string,
	rowSessionId: string,
	dedupePrefix: string,
): KiloMessageResult | null {
	const parsed = v.safeParse(kiloMessageSchema, value);
	if (!parsed.success || !shouldLoadKiloMessage(parsed.output)) {
		return null;
	}
	const entry = convertKiloMessageToUsageEntry(parsed.output, rowSessionId);
	if (entry == null) {
		return null;
	}
	return {
		id: parsed.output.id ?? `${dedupePrefix}:${rowId}`,
		entry,
	};
}

function loadKiloMessagesFromDb(kiloPath: string): KiloMessageResult[] {
	const dbPath = getKiloDbPath(kiloPath);
	if (dbPath == null || getSqliteDatabaseFactory() == null) {
		return [];
	}

	const result = Result.try({
		try: () =>
			withSqliteDatabase(
				dbPath,
				{ readOnly: true },
				(db) => {
					const rows = db.prepare('SELECT id, session_id, data FROM message').all();
					const records: KiloMessageResult[] = [];
					for (const rawRow of rows) {
						const rowResult = v.safeParse(kiloDbMessageRowSchema, rawRow);
						if (!rowResult.success) {
							continue;
						}

						const data = parseJsonObject(rowResult.output.data);
						if (data == null) {
							continue;
						}

						const result = parseKiloMessageRecord(
							data,
							rowResult.output.id,
							rowResult.output.session_id,
							dbPath,
						);
						if (result == null) {
							continue;
						}

						records.push(result);
					}
					return records;
				},
				logger.warn,
			),
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		logger.warn('Failed to load Kilo messages from DB:', result.error);
		return [];
	}
	return result.value ?? [];
}

export async function loadKiloMessages(): Promise<KiloUsageEntry[]> {
	const kiloPaths = getKiloPaths();
	if (kiloPaths.length === 0) {
		return [];
	}

	const entries: KiloUsageEntry[] = [];
	const seenIds = new Set<string>();
	for (const kiloPath of kiloPaths) {
		const dbMessages = loadKiloMessagesFromDb(kiloPath);
		for (const result of dbMessages) {
			if (seenIds.has(result.id)) {
				continue;
			}
			seenIds.add(result.id);
			entries.push(result.entry);
		}
	}

	return entries;
}

if (import.meta.vitest != null) {
	describe('loadKiloMessages', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it.skipIf(getSqliteDatabaseFactory() == null)('loads Kilo messages from SQLite', async () => {
			await using fixture = await createFixture({});
			withSqliteDatabase(
				fixture.getPath('kilo.db'),
				{ readOnly: false },
				(db) => {
					db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
					db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
						'row-1',
						'session-a',
						JSON.stringify({
							id: 'msg-1',
							role: 'assistant',
							providerID: 'anthropic',
							modelID: 'claude-sonnet-4-20250514',
							time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
							tokens: {
								input: 100,
								output: 50,
								reasoning: 5,
								cache: {
									write: 20,
									read: 10,
								},
							},
							cost: 0.02,
							agent: 'build',
						}),
					);
				},
				logger.warn,
			);
			vi.stubEnv('KILO_DATA_DIR', fixture.path);

			await expect(loadKiloMessages()).resolves.toMatchObject([
				{
					sessionID: 'session-a',
					model: 'claude-sonnet-4-20250514',
					providerID: 'anthropic',
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationInputTokens: 20,
						cacheReadInputTokens: 10,
						reasoningTokens: 5,
					},
					costUSD: 0.02,
					agent: 'build',
				},
			]);
		});

		it.skipIf(getSqliteDatabaseFactory() == null)(
			'ignores Kilo messages without timestamps',
			async () => {
				await using fixture = await createFixture({});
				withSqliteDatabase(
					fixture.getPath('kilo.db'),
					{ readOnly: false },
					(db) => {
						db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
						db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
							'msg-1',
							'session-a',
							JSON.stringify({
								role: 'assistant',
								providerID: 'openai',
								modelID: 'gpt-5',
								tokens: {
									input: 1,
									output: 1,
									cache: { read: 0, write: 0 },
								},
							}),
						);
					},
					logger.warn,
				);
				vi.stubEnv('KILO_DATA_DIR', fixture.path);

				await expect(loadKiloMessages()).resolves.toEqual([]);
			},
		);

		it.skipIf(getSqliteDatabaseFactory() == null)(
			'deduplicates Kilo DB messages across comma-separated KILO_DATA_DIR entries',
			async () => {
				const createDbMessage = (fixturePath: string, input: number): void => {
					withSqliteDatabase(
						fixturePath,
						{ readOnly: false },
						(db) => {
							db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
							db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
								'msg-1',
								'session-a',
								JSON.stringify({
									id: 'embedded-msg-1',
									role: 'assistant',
									providerID: 'openai',
									modelID: 'gpt-5',
									time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
									tokens: {
										input,
										output: 1,
										cache: { read: 0, write: 0 },
									},
								}),
							);
						},
						logger.warn,
					);
				};
				await using fixture1 = await createFixture({});
				await using fixture2 = await createFixture({});
				createDbMessage(fixture1.getPath('kilo.db'), 10);
				createDbMessage(fixture2.getPath('kilo.db'), 20);
				vi.stubEnv('KILO_DATA_DIR', `${fixture1.path},${fixture2.path}`);

				await expect(loadKiloMessages()).resolves.toMatchObject([
					{ sessionID: 'session-a', usage: { inputTokens: 10 } },
				]);
				await expect(loadKiloMessages()).resolves.toHaveLength(1);
			},
		);

		it.skipIf(getSqliteDatabaseFactory() == null)(
			'does not deduplicate fallback row ids from separate Kilo DB files',
			async () => {
				const createDbMessage = (fixturePath: string, sessionId: string, input: number): void => {
					withSqliteDatabase(
						fixturePath,
						{ readOnly: false },
						(db) => {
							db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
							db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
								'row-1',
								sessionId,
								JSON.stringify({
									role: 'assistant',
									providerID: 'openai',
									modelID: 'gpt-5',
									time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
									tokens: {
										input,
										output: 1,
										cache: { read: 0, write: 0 },
									},
								}),
							);
						},
						logger.warn,
					);
				};
				await using fixture1 = await createFixture({});
				await using fixture2 = await createFixture({});
				createDbMessage(fixture1.getPath('kilo.db'), 'session-a', 10);
				createDbMessage(fixture2.getPath('kilo.db'), 'session-b', 20);
				vi.stubEnv('KILO_DATA_DIR', `${fixture1.path},${fixture2.path}`);

				await expect(loadKiloMessages()).resolves.toMatchObject([
					{ sessionID: 'session-a', usage: { inputTokens: 10 } },
					{ sessionID: 'session-b', usage: { inputTokens: 20 } },
				]);
				await expect(loadKiloMessages()).resolves.toHaveLength(2);
			},
		);
	});
}
