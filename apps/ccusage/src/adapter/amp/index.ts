import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { AmpUsageEvent } from './schema.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadAmpUsageEvents } from './parser.ts';
import { detectAmpThreadFiles } from './paths.ts';
import { AMP_PROVIDER_PREFIXES, calculateAmpCost, loadOfflineAmpPricing } from './pricing.ts';

export async function detectAmp(): Promise<boolean> {
	return detectAmpThreadFiles();
}

function createAmpPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() =>
			new LiteLLMPricingFetcher({
				offline: options.offline === true,
				offlineLoader: loadOfflineAmpPricing,
				logger,
				providerPrefixes: AMP_PROVIDER_PREFIXES,
			}),
	);
}

export const loadAmpRows = defineAgentLogLoader<AmpUsageEvent, AgentPricingContext>({
	agent: 'amp',
	loadEntries: async () => loadAmpUsageEvents(),
	prepare: createAmpPricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.threadId,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: entry.cacheCreationInputTokens,
		cacheReadTokens: entry.cacheReadInputTokens,
		totalCost: await calculateAmpCost(prepared.fetcher, entry),
	}),
	getMetadata: (entries) => ({
		credits: entries.reduce((total, entry) => total + entry.credits, 0),
	}),
});

if (import.meta.vitest != null) {
	describe('loadAmpRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Amp thread usage into daily rows', async () => {
			await using fixture = await createFixture({
				threads: {
					'thread.json': JSON.stringify({
						id: 'thread-a',
						messages: [
							{
								role: 'assistant',
								messageId: 2,
								usage: {
									cacheCreationInputTokens: 20,
									cacheReadInputTokens: 10,
								},
							},
						],
						usageLedger: {
							events: [
								{
									timestamp: '2026-05-01T01:02:03.000Z',
									model: 'claude-sonnet-4-20250514',
									credits: 1.25,
									tokens: {
										input: 100,
										output: 50,
									},
									toMessageId: 2,
								},
							],
						},
					}),
				},
			});
			vi.stubEnv('AMP_DATA_DIR', fixture.path);

			await expect(
				loadAmpRows(
					'daily',
					{ offline: true, timezone: 'UTC' },
					{
						pricingFetcher: new LiteLLMPricingFetcher({
							offline: true,
							offlineLoader: async () => ({
								'claude-sonnet-4-20250514': {
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
					agent: 'amp',
					modelsUsed: ['claude-sonnet-4-20250514'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
					metadata: { credits: 1.25 },
				},
			]);
		});
	});
}
