import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { KimiUsageEntry } from './schema.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadKimiUsageEntries } from './parser.ts';
import { detectKimiWireFiles } from './paths.ts';
import { calculateKimiCost } from './pricing.ts';

export async function detectKimi(): Promise<boolean> {
	return detectKimiWireFiles();
}

function createKimiPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() => new LiteLLMPricingFetcher({ offline: options.offline === true, logger }),
	);
}

export const loadKimiRows = defineAgentLogLoader<KimiUsageEntry, AgentPricingContext>({
	agent: 'kimi',
	loadEntries: async () => loadKimiUsageEntries(),
	prepare: createKimiPricingContext,
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
		totalCost: await calculateKimiCost(entry, prepared.fetcher),
	}),
});

if (import.meta.vitest != null) {
	describe('loadKimiRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Kimi wire usage into daily rows', async () => {
			await using fixture = await createFixture({
				sessions: {
					group: {
						'session-a': {
							'wire.jsonl': JSON.stringify({
								timestamp: 1_767_312_000,
								message: {
									type: 'StatusUpdate',
									payload: {
										token_usage: {
											input_other: 100,
											output: 50,
											input_cache_read: 10,
											input_cache_creation: 20,
										},
										message_id: 'msg-1',
									},
								},
							}),
						},
					},
				},
			});
			vi.stubEnv('KIMI_DATA_DIR', fixture.path);

			await expect(
				loadKimiRows('daily', { offline: true, timezone: 'UTC' }, {}),
			).resolves.toMatchObject([
				{
					period: '2026-01-02',
					agent: 'kimi',
					modelsUsed: ['kimi-for-coding'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
				},
			]);
		});
	});
}
