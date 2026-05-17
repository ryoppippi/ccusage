import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { DroidUsageEntry } from './parser.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadDroidUsageEntries } from './parser.ts';
import { detectDroidSettingsFiles } from './paths.ts';
import { calculateDroidCost, DROID_PROVIDER_PREFIXES, loadOfflineDroidPricing } from './pricing.ts';

export async function detectDroid(): Promise<boolean> {
	return detectDroidSettingsFiles();
}

function createDroidPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() =>
			new LiteLLMPricingFetcher({
				offline: options.offline === true,
				offlineLoader: loadOfflineDroidPricing,
				logger,
				providerPrefixes: DROID_PROVIDER_PREFIXES,
			}),
	);
}

export const loadDroidRows = defineAgentLogLoader<DroidUsageEntry, AgentPricingContext>({
	agent: 'droid',
	loadEntries: async () => loadDroidUsageEntries(),
	prepare: createDroidPricingContext,
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
		totalCost: await calculateDroidCost(entry, prepared.fetcher),
	}),
});

if (import.meta.vitest != null) {
	describe('loadDroidRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Droid settings usage into daily rows', async () => {
			await using fixture = await createFixture({
				'session-a.settings.json': JSON.stringify({
					model: 'Claude-Sonnet-4-[Anthropic]',
					providerLock: 'anthropic',
					providerLockTimestamp: '2026-05-01T01:02:03.000Z',
					tokenUsage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationTokens: 20,
						cacheReadTokens: 10,
						thinkingTokens: 5,
					},
				}),
			});
			vi.stubEnv('DROID_SESSIONS_DIR', fixture.path);

			await expect(
				loadDroidRows(
					'daily',
					{ offline: true, timezone: 'UTC' },
					{
						pricingFetcher: new LiteLLMPricingFetcher({
							offline: true,
							offlineLoader: async () => ({
								'anthropic/claude-sonnet-4': {
									input_cost_per_token: 1e-6,
									output_cost_per_token: 2e-6,
									cache_creation_input_token_cost: 3e-6,
									cache_read_input_token_cost: 1e-7,
								},
							}),
						}),
					},
				),
			).resolves.toMatchObject([
				{
					period: '2026-05-01',
					agent: 'droid',
					modelsUsed: ['claude-sonnet-4'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 185,
				},
			]);
		});
	});
}
