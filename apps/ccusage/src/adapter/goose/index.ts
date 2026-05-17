import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { GooseUsageEntry } from './schema.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadGooseEntries } from './loader.ts';
import { hasGooseDatabase } from './paths.ts';
import { calculateGooseCost } from './pricing.ts';

export async function detectGoose(): Promise<boolean> {
	return getSqliteDatabaseFactory(logger.warn) != null && hasGooseDatabase();
}

function createGoosePricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() => new LiteLLMPricingFetcher({ offline: options.offline === true, logger }),
	);
}

export const loadGooseRows = defineAgentLogLoader<GooseUsageEntry, AgentPricingContext>({
	agent: 'goose',
	loadEntries: async () => loadGooseEntries(),
	prepare: createGoosePricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp.toISOString(),
	getSessionId: (entry) => entry.sessionID,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: entry.totalTokens,
		totalCost: await calculateGooseCost(entry, prepared.fetcher),
	}),
	getMetadata: (entries, kind) =>
		kind === 'session'
			? {
					lastActivity: entries.reduce<string | undefined>((latest, entry) => {
						const timestamp = entry.timestamp.toISOString();
						return latest == null || timestamp > latest ? timestamp : latest;
					}, undefined),
				}
			: undefined,
});

if (import.meta.vitest != null) {
	describe('loadGooseRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Goose usage into daily rows', async () => {
			await using fixture = await createFixture({
				data: {
					sessions: {
						'sessions.db': '',
					},
				},
			});
			vi.stubEnv('GOOSE_PATH_ROOT', fixture.path);

			withSqliteDatabase(
				fixture.getPath('data/sessions/sessions.db'),
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
					db.prepare(
						`INSERT INTO sessions (
	id,
	model_config_json,
	provider_name,
	created_at,
	accumulated_total_tokens,
	accumulated_input_tokens,
	accumulated_output_tokens
) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					).run(
						'session-a',
						'{"model_name":"claude-sonnet-4-20250514"}',
						'anthropic',
						'2026-05-01T01:02:03Z',
						160,
						100,
						50,
					);
				},
				logger.warn,
			);

			await expect(
				loadGooseRows(
					'daily',
					{ offline: true, timezone: 'UTC' },
					{
						pricingFetcher: {
							calculateCostFromTokens: vi.fn(async () => Result.succeed(0.02)),
						} as unknown as LiteLLMPricingFetcher,
					},
				),
			).resolves.toMatchObject([
				{
					period: '2026-05-01',
					agent: 'goose',
					modelsUsed: ['claude-sonnet-4-20250514'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalTokens: 160,
					totalCost: 0.02,
				},
			]);
		});
	});
}
