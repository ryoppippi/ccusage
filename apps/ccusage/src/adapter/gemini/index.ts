import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions } from '../types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader } from '../shared.ts';
import { loadGeminiUsageEvents } from './parser.ts';
import { detectGeminiLogFiles, GEMINI_DATA_DIR_ENV } from './paths.ts';
import {
	calculateGeminiCost,
	GEMINI_PROVIDER_PREFIXES,
	loadOfflineGeminiPricing,
} from './pricing.ts';

export async function detectGemini(): Promise<boolean> {
	return detectGeminiLogFiles();
}

function createGeminiPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() =>
			new LiteLLMPricingFetcher({
				offline: options.offline === true,
				offlineLoader: loadOfflineGeminiPricing,
				logger,
				providerPrefixes: GEMINI_PROVIDER_PREFIXES,
			}),
	);
}

export const loadGeminiRows = defineAgentLogLoader({
	agent: 'gemini',
	loadEntries: async () => loadGeminiUsageEvents(),
	prepare: createGeminiPricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.sessionId,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: 0,
		cacheReadTokens: entry.cacheReadTokens,
		totalTokens: entry.totalTokens,
		totalCost: await calculateGeminiCost(entry, prepared.fetcher),
	}),
	getMetadata: (entries) => ({
		reasoningTokens: entries.reduce((total, entry) => total + entry.reasoningTokens, 0),
		toolTokens: entries.reduce((total, entry) => total + entry.toolTokens, 0),
	}),
});

if (import.meta.vitest != null) {
	describe('loadGeminiRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Gemini usage with cached input and reasoning tokens', async () => {
			await using fixture = await createFixture({
				project: {
					chats: {
						'session-a.jsonl': [
							JSON.stringify({
								sessionId: 'session-a',
								projectHash: 'project-a',
								startTime: '2026-05-17T11:07:00.000Z',
							}),
							JSON.stringify({
								id: 'msg-a',
								timestamp: '2026-05-17T11:07:32.000Z',
								type: 'gemini',
								model: 'gemini-3-flash-preview',
								tokens: {
									input: 15_327,
									output: 23,
									cached: 11_526,
									thoughts: 919,
									tool: 0,
									total: 16_269,
								},
							}),
						].join('\n'),
					},
				},
			});
			vi.stubEnv(GEMINI_DATA_DIR_ENV, fixture.path);

			const rows = await loadGeminiRows(
				'daily',
				{ offline: true, timezone: 'UTC' },
				{
					pricingFetcher: new LiteLLMPricingFetcher({
						offline: true,
						offlineLoader: async () => ({
							'gemini-3-flash-preview': {
								input_cost_per_token: 1e-6,
								output_cost_per_token: 2e-6,
								cache_read_input_token_cost: 1e-7,
							},
						}),
					}),
				},
			);

			expect(rows).toMatchObject([
				{
					period: '2026-05-17',
					agent: 'gemini',
					modelsUsed: ['gemini-3-flash-preview'],
					inputTokens: 3_801,
					outputTokens: 23,
					cacheReadTokens: 11_526,
					totalTokens: 16_269,
					metadata: { reasoningTokens: 919, toolTokens: 0 },
				},
			]);
			expect(rows[0]!.totalCost).toBeCloseTo(0.0068376);
		});
	});
}
