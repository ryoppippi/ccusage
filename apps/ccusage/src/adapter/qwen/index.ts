import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadQwenUsageEntries } from './parser.ts';
import { detectQwenChatFiles } from './paths.ts';
import { calculateQwenCost } from './pricing.ts';

export async function detectQwen(): Promise<boolean> {
	return detectQwenChatFiles();
}

function createQwenPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() => new LiteLLMPricingFetcher({ offline: options.offline === true, logger }),
	);
}

export const loadQwenRows = defineAgentLogLoader({
	agent: 'qwen',
	loadEntries: async () => loadQwenUsageEntries(),
	prepare: createQwenPricingContext,
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
		totalCost: await calculateQwenCost(entry, prepared.fetcher),
	}),
	getMetadata: (entries, kind) =>
		kind === 'session' ? { projectPath: entries[0]?.project } : undefined,
}) satisfies (
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
) => Promise<AgentUsageRow[]>;

if (import.meta.vitest != null) {
	describe('loadQwenRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Qwen usage rows by day', async () => {
			await using fixture = await createFixture({
				projects: {
					myProject: {
						chats: {
							'chat-a.jsonl': JSON.stringify({
								type: 'assistant',
								model: 'qwen3-coder-plus',
								timestamp: '2026-02-23T14:24:56.857Z',
								sessionId: 'session-json',
								usageMetadata: {
									promptTokenCount: 100,
									candidatesTokenCount: 50,
									thoughtsTokenCount: 10,
									cachedContentTokenCount: 5,
								},
							}),
						},
					},
				},
			});
			vi.stubEnv('QWEN_DATA_DIR', fixture.path);

			await expect(
				loadQwenRows(
					'daily',
					{ offline: true, timezone: 'UTC' },
					{
						pricingFetcher: new LiteLLMPricingFetcher({
							offline: true,
							offlineLoader: async () => ({
								'qwen/qwen3-coder-plus': {
									input_cost_per_token: 1e-6,
									output_cost_per_token: 2e-6,
									cache_read_input_token_cost: 1e-7,
								},
							}),
						}),
					},
				),
			).resolves.toMatchObject([
				{
					agent: 'qwen',
					cacheCreationTokens: 0,
					cacheReadTokens: 5,
					inputTokens: 100,
					modelsUsed: ['qwen3-coder-plus'],
					outputTokens: 50,
					period: '2026-02-23',
					totalCost: 0.0002205,
					totalTokens: 165,
				},
			]);
		});
	});
}
