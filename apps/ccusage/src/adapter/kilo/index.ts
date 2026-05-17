import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { KiloUsageEntry } from './schema.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { getSqliteDatabaseFactory, withSqliteDatabase } from '@ccusage/internal/sqlite';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadKiloMessages } from './loader.ts';
import { detectKiloSources, getKiloPaths } from './paths.ts';
import { calculateKiloCost } from './pricing.ts';

export async function detectKilo(): Promise<boolean> {
	const results = await Promise.all(getKiloPaths().map(detectKiloSources));
	return results.some(Boolean);
}

function createKiloPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() => new LiteLLMPricingFetcher({ offline: options.offline === true, logger }),
	);
}

export const loadKiloRows = defineAgentLogLoader<KiloUsageEntry, AgentPricingContext>({
	agent: 'kilo',
	loadEntries: async () => loadKiloMessages(),
	prepare: createKiloPricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp.toISOString(),
	getSessionId: (entry) => entry.sessionID,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.usage.inputTokens,
		outputTokens: entry.usage.outputTokens,
		cacheCreationTokens: entry.usage.cacheCreationInputTokens,
		cacheReadTokens: entry.usage.cacheReadInputTokens,
		totalTokens:
			entry.usage.inputTokens +
			entry.usage.outputTokens +
			entry.usage.cacheCreationInputTokens +
			entry.usage.cacheReadInputTokens +
			entry.usage.reasoningTokens,
		totalCost: await calculateKiloCost(entry, prepared.fetcher),
	}),
	getMetadata: (entries) => {
		const agents = Array.from(
			new Set(
				entries.map((entry) => entry.agent).filter((agent): agent is string => agent != null),
			),
		).sort();
		return agents.length === 0 ? undefined : { kiloAgents: agents };
	},
});

if (import.meta.vitest != null) {
	describe('loadKiloRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it.skipIf(getSqliteDatabaseFactory() == null)(
			'aggregates Kilo message usage into daily rows',
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
								time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
								tokens: {
									input: 100,
									output: 50,
									reasoning: 5,
									cache: { write: 20, read: 10 },
								},
								cost: 0.02,
								agent: 'build',
							}),
						);
					},
					logger.warn,
				);
				vi.stubEnv('KILO_DATA_DIR', fixture.path);

				await expect(
					loadKiloRows('daily', { offline: true, timezone: 'UTC' }, {}),
				).resolves.toMatchObject([
					{
						period: '2026-05-01',
						agent: 'kilo',
						modelsUsed: ['gpt-5'],
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationTokens: 20,
						cacheReadTokens: 10,
						totalTokens: 185,
						totalCost: 0.02,
						metadata: { kiloAgents: ['build'] },
					},
				]);
			},
		);

		it.skipIf(getSqliteDatabaseFactory() == null)('detects a Kilo database source', async () => {
			await using fixture = await createFixture({
				'kilo.db': '',
			});
			vi.stubEnv('KILO_DATA_DIR', fixture.path);

			await expect(detectKilo()).resolves.toBe(true);
		});
	});
}
