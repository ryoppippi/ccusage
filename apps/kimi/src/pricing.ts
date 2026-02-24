import type { ModelPricing, PricingSource } from './_types.ts';
import { logger } from './logger.ts';

const warnedModels = new Set<string>();

function normalizeModelName(model: string): string {
	const trimmed = model.trim();
	if (trimmed === '') {
		return 'unknown';
	}

	const lastSegment = (() => {
		const idx = trimmed.lastIndexOf('/');
		return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
	})();

	return lastSegment;
}

const KIMI_K2_5_PRICING: ModelPricing = {
	// Official docs pricing (unit: 1M tokens)
	// Input Price (Cache Miss) -> non-cached input tokens
	// Input Price (Cache Hit)  -> cached input tokens (input_cache_read)
	inputCostPerMToken: 0.6,
	cachedInputCostPerMToken: 0.1,
	outputCostPerMToken: 3,
};

const PRICING_TABLE = new Map<string, ModelPricing>([
	['kimi-k2.5', KIMI_K2_5_PRICING],
	// Kimi CLI model aliases are "powered by kimi-k2.5" (see kimi-cli `model_display_name`).
	['kimi-for-coding', KIMI_K2_5_PRICING],
	['kimi-code', KIMI_K2_5_PRICING],

	[
		'kimi-k2-0905-preview',
		{ inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.15, outputCostPerMToken: 2.5 },
	],
	[
		'kimi-k2-0711-preview',
		{ inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.15, outputCostPerMToken: 2.5 },
	],
	[
		'kimi-k2-turbo-preview',
		{ inputCostPerMToken: 1.15, cachedInputCostPerMToken: 0.15, outputCostPerMToken: 8 },
	],
	[
		'kimi-k2-thinking',
		{ inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.15, outputCostPerMToken: 2.5 },
	],
	[
		'kimi-k2-thinking-turbo',
		{ inputCostPerMToken: 1.15, cachedInputCostPerMToken: 0.15, outputCostPerMToken: 8 },
	],
]);

export class KimiPricingSource implements PricingSource {
	async getPricing(_model: string): Promise<ModelPricing> {
		const model = normalizeModelName(_model);
		const pricing = PRICING_TABLE.get(model);
		if (pricing != null) {
			return pricing;
		}

		if (!warnedModels.has(model)) {
			warnedModels.add(model);
			logger.warn(
				`Unknown Kimi model for pricing: ${_model} (normalized: ${model}). Using $0 pricing.`,
			);
		}

		// Kimi CLI logs do not currently include costUSD, so we rely on this table.
		// If the model is unknown, keep token usage visible without failing report builds.
		return {
			inputCostPerMToken: 0,
			cachedInputCostPerMToken: 0,
			outputCostPerMToken: 0,
		};
	}
}

if (import.meta.vitest != null) {
	describe('KimiPricingSource', () => {
		it('returns official pricing for known models', async () => {
			const source = new KimiPricingSource();

			await expect(source.getPricing('kimi-k2.5')).resolves.toEqual({
				inputCostPerMToken: 0.6,
				cachedInputCostPerMToken: 0.1,
				outputCostPerMToken: 3,
			});

			await expect(source.getPricing('kimi-code/kimi-for-coding')).resolves.toEqual({
				inputCostPerMToken: 0.6,
				cachedInputCostPerMToken: 0.1,
				outputCostPerMToken: 3,
			});

			await expect(source.getPricing('kimi-k2-turbo-preview')).resolves.toEqual({
				inputCostPerMToken: 1.15,
				cachedInputCostPerMToken: 0.15,
				outputCostPerMToken: 8,
			});
		});

		it('returns zero pricing for unknown models', async () => {
			const source = new KimiPricingSource();
			await expect(source.getPricing('unknown-model-xyz')).resolves.toEqual({
				inputCostPerMToken: 0,
				cachedInputCostPerMToken: 0,
				outputCostPerMToken: 0,
			});
		});
	});
}
