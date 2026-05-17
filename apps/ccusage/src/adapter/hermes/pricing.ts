import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { HermesUsageEntry } from './parser.ts';
import { Result } from '@praha/byethrow';
import { logger } from '../../logger.ts';

type HermesPricingFetcher = Pick<LiteLLMPricingFetcher, 'calculateCostFromTokens'>;

function createModelCandidates(entry: HermesUsageEntry): string[] {
	const candidates = [entry.model];
	if (entry.provider !== 'hermes') {
		candidates.push(`${entry.provider}/${entry.model}`);
	}
	return Array.from(new Set(candidates));
}

export async function calculateHermesCost(
	entry: HermesUsageEntry,
	fetcher: HermesPricingFetcher,
): Promise<number> {
	if (entry.costUSD != null) {
		return entry.costUSD;
	}

	const tokens = {
		input_tokens: entry.inputTokens,
		output_tokens: entry.outputTokens + entry.reasoningTokens,
		cache_creation_input_tokens: entry.cacheCreationTokens,
		cache_read_input_tokens: entry.cacheReadTokens,
	};

	const candidates = createModelCandidates(entry);
	for (const candidate of candidates) {
		const result = await fetcher.calculateCostFromTokens(tokens, candidate);
		if (Result.isSuccess(result) && Number.isFinite(result.value) && result.value >= 0) {
			return result.value;
		}
	}

	logger.warn('Hermes pricing not found; falling back to 0', {
		sessionId: entry.sessionId,
		model: entry.model,
		provider: entry.provider,
		tokens,
		candidates,
	});

	return 0;
}

if (import.meta.vitest != null) {
	describe('calculateHermesCost', () => {
		it('uses a recorded zero cost without falling back to token pricing', async () => {
			const calculateCostFromTokens = vi.fn(async () => Result.succeed(1.23));

			await expect(
				calculateHermesCost(
					{
						timestamp: '2026-05-17T00:00:00.000Z',
						sessionId: 'session-free',
						model: 'gpt-5.4',
						provider: 'openai',
						inputTokens: 100,
						outputTokens: 20,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						reasoningTokens: 0,
						messageCount: 1,
						costUSD: 0,
					},
					{ calculateCostFromTokens },
				),
			).resolves.toBe(0);
			expect(calculateCostFromTokens).not.toHaveBeenCalled();
		});

		it('warns when all pricing candidates miss', async () => {
			const calculateCostFromTokens = vi.fn(async () => Result.succeed(Number.NaN));
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

			await expect(
				calculateHermesCost(
					{
						timestamp: '2026-05-17T00:00:00.000Z',
						sessionId: 'session-missing-pricing',
						model: 'custom-model',
						provider: 'custom_provider',
						inputTokens: 100,
						outputTokens: 20,
						cacheCreationTokens: 1,
						cacheReadTokens: 2,
						reasoningTokens: 3,
						messageCount: 1,
						costUSD: null,
					},
					{ calculateCostFromTokens },
				),
			).resolves.toBe(0);

			expect(calculateCostFromTokens).toHaveBeenCalledTimes(2);
			expect(warn).toHaveBeenCalledWith('Hermes pricing not found; falling back to 0', {
				sessionId: 'session-missing-pricing',
				model: 'custom-model',
				provider: 'custom_provider',
				tokens: {
					input_tokens: 100,
					output_tokens: 23,
					cache_creation_input_tokens: 1,
					cache_read_input_tokens: 2,
				},
				candidates: ['custom-model', 'custom_provider/custom-model'],
			});

			warn.mockRestore();
		});
	});
}
