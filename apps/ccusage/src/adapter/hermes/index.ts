import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import path from 'node:path';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { hasReadonlySqliteSupport } from '../sqlite.ts';
import { loadHermesUsageEntries } from './parser.ts';
import { detectHermesStateDb } from './paths.ts';
import { calculateHermesCost } from './pricing.ts';

export async function detectHermes(): Promise<boolean> {
	return hasReadonlySqliteSupport() && detectHermesStateDb();
}

function createHermesPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() => new LiteLLMPricingFetcher({ offline: options.offline === true, logger }),
	);
}

export const loadHermesRows = defineAgentLogLoader({
	agent: 'hermes',
	loadEntries: async () => loadHermesUsageEntries(),
	prepare: createHermesPricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.sessionId,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: entry.cacheCreationTokens,
		cacheReadTokens: entry.cacheReadTokens,
		totalTokens:
			entry.inputTokens +
			entry.outputTokens +
			entry.cacheCreationTokens +
			entry.cacheReadTokens +
			entry.reasoningTokens,
		totalCost: await calculateHermesCost(entry, prepared.fetcher),
	}),
	getMetadata: (entries) => ({
		messageCount: entries.reduce((total, entry) => total + entry.messageCount, 0),
	}),
}) satisfies (
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
) => Promise<AgentUsageRow[]>;

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

	describe('Hermes Agent adapter rows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it.skipIf(getSqliteDatabaseFactory(() => {}) == null)(
			'aggregates Hermes sessions into daily rows',
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
				vi.stubEnv('HERMES_HOME', fixture.path);

				await expect(loadHermesRows('daily', { timezone: 'UTC' }, {})).resolves.toMatchObject([
					{
						period: '2025-06-15',
						agent: 'hermes',
						modelsUsed: ['claude-sonnet-4-20250514'],
						inputTokens: 1200,
						outputTokens: 300,
						cacheCreationTokens: 20,
						cacheReadTokens: 50,
						totalTokens: 1580,
						totalCost: 0.34,
						metadata: { messageCount: 42 },
					},
				]);
			},
		);
	});
}
