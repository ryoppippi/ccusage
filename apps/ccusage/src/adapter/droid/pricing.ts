import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { DroidUsageEntry } from './parser.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';

export const DROID_PROVIDER_PREFIXES = [
	'anthropic/',
	'openai/',
	'google/',
	'vertex_ai/',
	'xai/',
	'openrouter/anthropic/',
	'openrouter/openai/',
	'openrouter/google/',
	'openrouter/x-ai/',
];

export async function loadOfflineDroidPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	return {};
}

function providerPrefixes(provider: string): string[] {
	switch (provider) {
		case 'anthropic':
			return ['anthropic/', 'openrouter/anthropic/'];
		case 'openai':
			return ['openai/', 'openrouter/openai/'];
		case 'google':
			return ['google/', 'vertex_ai/', 'openrouter/google/'];
		case 'xai':
			return ['xai/', 'openrouter/x-ai/'];
		case 'unknown':
			return [];
		default:
			return [`${provider}/`, `openrouter/${provider}/`];
	}
}

function createDroidModelCandidates(entry: DroidUsageEntry): string[] {
	return Array.from(
		new Set([
			entry.model,
			...providerPrefixes(entry.provider).map((prefix) => `${prefix}${entry.model}`),
		]),
	);
}

export async function calculateDroidCost(
	entry: DroidUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	const tokens = {
		input_tokens: entry.inputTokens,
		output_tokens: entry.outputTokens + entry.reasoningTokens,
		cache_creation_input_tokens: entry.cacheCreationTokens,
		cache_read_input_tokens: entry.cacheReadTokens,
	};

	for (const candidate of createDroidModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}

if (import.meta.vitest != null) {
	describe('calculateDroidCost', () => {
		it('tries provider-prefixed model names', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'anthropic/claude-sonnet-4': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			await expect(
				calculateDroidCost(
					{
						timestamp: '2026-05-01T01:02:03.000Z',
						sessionId: 'session-a',
						model: 'claude-sonnet-4',
						provider: 'anthropic',
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						reasoningTokens: 5,
					},
					fetcher,
				),
			).resolves.toBeCloseTo(0.00021);
		});

		it('tries OpenRouter-prefixed provider model names', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'openrouter/anthropic/claude-sonnet-4': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			await expect(
				calculateDroidCost(
					{
						timestamp: '2026-05-01T01:02:03.000Z',
						sessionId: 'session-a',
						model: 'claude-sonnet-4',
						provider: 'anthropic',
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						reasoningTokens: 5,
					},
					fetcher,
				),
			).resolves.toBeCloseTo(0.00021);
		});
	});
}
