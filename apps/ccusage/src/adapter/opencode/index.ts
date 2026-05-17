import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { OpenCodeUsageEntry } from './schema.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadOpenCodeMessages } from './loader.ts';
import { detectOpenCodeSources, getOpenCodePath } from './paths.ts';
import { calculateOpenCodeCost } from './pricing.ts';

export async function detectOpenCode(): Promise<boolean> {
	const openCodePath = getOpenCodePath();
	return openCodePath != null && (await detectOpenCodeSources(openCodePath));
}

function createOpenCodePricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() => new LiteLLMPricingFetcher({ offline: options.offline === true, logger }),
	);
}

export const loadOpenCodeRows = defineAgentLogLoader<OpenCodeUsageEntry, AgentPricingContext>({
	agent: 'opencode',
	loadEntries: async () => loadOpenCodeMessages(),
	prepare: createOpenCodePricingContext,
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
		totalCost: await calculateOpenCodeCost(entry, prepared.fetcher),
	}),
});

if (import.meta.vitest != null) {
	describe('loadOpenCodeRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates OpenCode message usage into daily rows', async () => {
			await using fixture = await createFixture({
				storage: {
					message: {
						'message.json': JSON.stringify({
							id: 'msg-1',
							sessionID: 'session-a',
							providerID: 'openai',
							modelID: 'gpt-5',
							time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
							tokens: {
								input: 100,
								output: 50,
								cache: {
									write: 20,
									read: 10,
								},
							},
							cost: 0.02,
						}),
					},
				},
			});
			vi.stubEnv('OPENCODE_DATA_DIR', fixture.path);

			await expect(
				loadOpenCodeRows('daily', { offline: true, timezone: 'UTC' }, {}),
			).resolves.toMatchObject([
				{
					period: '2026-05-01',
					agent: 'opencode',
					modelsUsed: ['gpt-5'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
					totalCost: 0.02,
				},
			]);
		});
	});
}
