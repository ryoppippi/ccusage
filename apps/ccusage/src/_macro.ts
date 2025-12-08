import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import process from 'node:process';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

export function isClaudeModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return modelName.startsWith('claude-')
		|| modelName.startsWith('anthropic.claude-')
		|| modelName.startsWith('anthropic/claude-');
}

if (import.meta.vitest != null) {
	describe('isClaudeModel', () => {
		const mockPricing = {} as LiteLLMModelPricing;

		it('matches claude- prefixed models', () => {
			expect(isClaudeModel('claude-sonnet-4-20250514', mockPricing)).toBe(true);
			expect(isClaudeModel('claude-opus-4-5-20251101', mockPricing)).toBe(true);
		});

		it('matches anthropic.claude- prefixed models (Bedrock format)', () => {
			expect(isClaudeModel('anthropic.claude-opus-4-5-20251101-v1:0', mockPricing)).toBe(true);
			expect(isClaudeModel('anthropic.claude-sonnet-4-20250514-v1:0', mockPricing)).toBe(true);
		});

		it('matches anthropic/claude- prefixed models', () => {
			expect(isClaudeModel('anthropic/claude-sonnet-4-20250514', mockPricing)).toBe(true);
		});

		it('rejects non-Claude models', () => {
			expect(isClaudeModel('gpt-4', mockPricing)).toBe(false);
			expect(isClaudeModel('gemini-pro', mockPricing)).toBe(false);
		});
	});
}

export async function prefetchClaudePricing(): Promise<Record<string, LiteLLMModelPricing>> {
	if (process.env.OFFLINE === 'true') {
		return createPricingDataset();
	}

	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isClaudeModel);
	}
	catch (error) {
		console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
