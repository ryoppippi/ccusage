import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { GooseUsageEntry } from './schema.ts';
import { Result } from '@praha/byethrow';

function normalizeProvider(provider: string): string {
	return provider.replaceAll('-', '_');
}

function createGooseModelCandidates(entry: GooseUsageEntry): string[] {
	const candidates = [entry.model];
	if (entry.providerID !== 'goose') {
		const provider = normalizeProvider(entry.providerID);
		candidates.push(`${provider}/${entry.model}`);
	}
	return Array.from(new Set(candidates));
}

export async function calculateGooseCost(
	entry: GooseUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	const tokens = {
		input_tokens: entry.inputTokens,
		output_tokens: entry.outputTokens + entry.reasoningTokens,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};

	for (const candidate of createGooseModelCandidates(entry)) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && result.value > 0) {
			return result.value;
		}
	}

	return 0;
}

if (import.meta.vitest != null) {
	describe('calculateGooseCost', () => {
		it('tries provider-prefixed model candidates after the raw model', async () => {
			const calls: string[] = [];
			const fetcher = {
				calculateCostFromTokens: vi.fn(async (_tokens: unknown, model: string) => {
					calls.push(model);
					return model === 'anthropic/claude-sonnet-4-20250514'
						? Result.succeed(0.02)
						: Result.succeed(0);
				}),
			} as unknown as LiteLLMPricingFetcher;

			await expect(
				calculateGooseCost(
					{
						timestamp: new Date('2026-05-01T00:00:00.000Z'),
						sessionID: 'session-a',
						model: 'claude-sonnet-4-20250514',
						providerID: 'anthropic',
						inputTokens: 100,
						outputTokens: 50,
						reasoningTokens: 10,
						totalTokens: 160,
					},
					fetcher,
				),
			).resolves.toBe(0.02);
			expect(calls).toEqual(['claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4-20250514']);
		});
	});
}
