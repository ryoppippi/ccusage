import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import type { CodebuffUsageEntry } from './parser.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadCodebuffUsageEntries } from './parser.ts';
import { detectCodebuffChatFiles } from './paths.ts';
import {
	calculateCodebuffCost,
	CODEBUFF_PROVIDER_PREFIXES,
	loadOfflineCodebuffPricing,
} from './pricing.ts';

export async function detectCodebuff(): Promise<boolean> {
	return detectCodebuffChatFiles();
}

function createCodebuffPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() =>
			new LiteLLMPricingFetcher({
				offline: options.offline === true,
				offlineLoader: loadOfflineCodebuffPricing,
				logger,
				providerPrefixes: [...CODEBUFF_PROVIDER_PREFIXES],
			}),
	);
}

export const loadCodebuffRows = defineAgentLogLoader<CodebuffUsageEntry, AgentPricingContext>({
	agent: 'codebuff',
	loadEntries: async () => loadCodebuffUsageEntries(),
	prepare: createCodebuffPricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.sessionId,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: entry.cacheCreationInputTokens,
		cacheReadTokens: entry.cacheReadInputTokens,
		totalCost: await calculateCodebuffCost(prepared.fetcher, entry),
	}),
	getMetadata: (entries) => ({
		credits: entries.reduce((total, entry) => total + entry.credits, 0),
	}),
});

if (import.meta.vitest != null) {
	describe('loadCodebuffRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Codebuff chat usage into daily rows', async () => {
			await using fixture = await createFixture({
				projects: {
					project: {
						chats: {
							'2026-01-02T03-04-05.000Z': {
								'chat-messages.json': JSON.stringify([
									{
										role: 'assistant',
										metadata: {
											model: 'claude-sonnet-4-20250514',
											usage: {
												inputTokens: 100,
												outputTokens: 50,
												cacheCreationInputTokens: 20,
												cacheReadInputTokens: 10,
											},
										},
										credits: 1.25,
									},
								]),
							},
						},
					},
				},
			});
			vi.stubEnv('CODEBUFF_DATA_DIR', fixture.path);

			await expect(
				loadCodebuffRows('daily', { offline: true, timezone: 'UTC' }, {}),
			).resolves.toMatchObject([
				{
					period: '2026-01-02',
					agent: 'codebuff',
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
