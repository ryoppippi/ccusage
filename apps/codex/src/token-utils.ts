import type { ModelPricing, TokenUsageDelta, TokenUsageEvent } from './_types.ts';
import { formatCurrency, formatTokens } from '@ccusage/internal/format';
import { MILLION } from './_consts.ts';

// Personal workaround: Codex logs do not expose a per-turn fast-mode signal.
// These windows reflect local usage where fast mode was enabled for all turns.
export const CODEX_FAST_COST_MULTIPLIER_START = '2026-04-07T00:00:00.000Z';
export const CODEX_FAST_COST_MULTIPLIER_END = '2026-05-09T00:00:00.000Z';
export const CODEX_FAST_COST_MULTIPLIER_RESTART = '2026-05-14T19:33:00.000Z';
const CODEX_FAST_COST_MULTIPLIER = 2;
const CODEX_FAST_COST_MULTIPLIERS_BY_MODEL = new Map([['gpt-5.5', 2.5]]);
export const CODEX_COST_RULES_CACHE_KEY =
	'codex-fast-cost-v4:start=2026-04-07T00:00:00.000Z;end=2026-05-09T00:00:00.000Z;restart=2026-05-14T19:33:00.000Z;default=2;gpt-5.5=2.5';
const CODEX_FAST_COST_MULTIPLIER_START_MS = Date.parse(CODEX_FAST_COST_MULTIPLIER_START);
const CODEX_FAST_COST_MULTIPLIER_END_MS = Date.parse(CODEX_FAST_COST_MULTIPLIER_END);
const CODEX_FAST_COST_MULTIPLIER_RESTART_MS = Date.parse(CODEX_FAST_COST_MULTIPLIER_RESTART);

export function createEmptyUsage(): TokenUsageDelta {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};
}

export function addUsage(target: TokenUsageDelta, delta: TokenUsageDelta): void {
	target.inputTokens += delta.inputTokens;
	target.cachedInputTokens += delta.cachedInputTokens;
	target.outputTokens += delta.outputTokens;
	target.reasoningOutputTokens += delta.reasoningOutputTokens;
	target.totalTokens += delta.totalTokens;
}

function nonCachedInputTokens(usage: TokenUsageDelta): number {
	const nonCached = usage.inputTokens - usage.cachedInputTokens;
	return nonCached > 0 ? nonCached : 0;
}

/**
 * Calculate the cost in USD for token usage based on model pricing
 *
 * @param usage - Token usage data including input, output, cached, and reasoning tokens
 * @param pricing - Model-specific pricing rates per million tokens
 * @returns Cost in USD
 *
 * @remarks
 * - Cached input tokens receive a 50% discount from OpenAI
 * @see {@link https://platform.openai.com/docs/guides/prompt-caching}
 *
 * - Reasoning tokens are already included in output_tokens, so they are not added separately
 * to avoid double-counting
 */
export function calculateCostUSD(usage: TokenUsageDelta, pricing: ModelPricing): number {
	const nonCachedInput = nonCachedInputTokens(usage);
	const cachedInput =
		usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens;
	const outputTokens = usage.outputTokens;

	const inputCost = (nonCachedInput / MILLION) * pricing.inputCostPerMToken;
	const cachedCost = (cachedInput / MILLION) * pricing.cachedInputCostPerMToken;
	const outputCost = (outputTokens / MILLION) * pricing.outputCostPerMToken;

	return inputCost + cachedCost + outputCost;
}

function normalizeModelName(model: string | undefined): string | undefined {
	const normalized = model?.trim().toLowerCase();
	if (normalized == null || normalized === '') {
		return undefined;
	}

	for (const prefix of ['openai/', 'azure/', 'openrouter/openai/']) {
		if (normalized.startsWith(prefix)) {
			return normalized.slice(prefix.length);
		}
	}

	return normalized;
}

function getFastCostMultiplier(model: string | undefined): number {
	const normalizedModel = normalizeModelName(model);
	if (normalizedModel == null) {
		return CODEX_FAST_COST_MULTIPLIER;
	}

	return CODEX_FAST_COST_MULTIPLIERS_BY_MODEL.get(normalizedModel) ?? CODEX_FAST_COST_MULTIPLIER;
}

export function getCostMultiplierForTimestamp(timestamp: string, model?: string): number {
	const timestampMs = Date.parse(timestamp);
	if (Number.isNaN(timestampMs)) {
		return 1;
	}

	if (
		(timestampMs >= CODEX_FAST_COST_MULTIPLIER_START_MS &&
			timestampMs < CODEX_FAST_COST_MULTIPLIER_END_MS) ||
		timestampMs >= CODEX_FAST_COST_MULTIPLIER_RESTART_MS
	) {
		return getFastCostMultiplier(model);
	}

	return 1;
}

export function calculateCostUSDForEvent(event: TokenUsageEvent, pricing: ModelPricing): number {
	return (
		calculateCostUSD(event, pricing) * getCostMultiplierForTimestamp(event.timestamp, event.model)
	);
}

export { formatCurrency, formatTokens };

if (import.meta.vitest != null) {
	describe('Codex fast cost multiplier', () => {
		const pricing: ModelPricing = {
			inputCostPerMToken: 1,
			cachedInputCostPerMToken: 0.1,
			outputCostPerMToken: 10,
		};
		const event: TokenUsageEvent = {
			sessionId: 'session-1',
			timestamp: '2026-04-07T00:00:00.000Z',
			inputTokens: 1_000_000,
			cachedInputTokens: 100_000,
			outputTokens: 10_000,
			reasoningOutputTokens: 0,
			totalTokens: 1_010_000,
		};

		it('does not multiply Codex costs before April 7 2026', () => {
			const beforeFast = {
				...event,
				timestamp: '2026-04-06T23:59:59.999Z',
			};

			expect(calculateCostUSDForEvent(beforeFast, pricing)).toBeCloseTo(
				calculateCostUSD(beforeFast, pricing),
			);
		});

		it('applies the default 2x Codex fast multiplier from April 7 2026 through May 8 2026', () => {
			expect(calculateCostUSDForEvent(event, pricing)).toBeCloseTo(
				calculateCostUSD(event, pricing) * 2,
			);
		});

		it('applies the gpt-5.5 2.5x Codex fast multiplier from April 7 2026 through May 8 2026', () => {
			const gpt55Event = {
				...event,
				model: 'gpt-5.5',
			};

			expect(calculateCostUSDForEvent(gpt55Event, pricing)).toBeCloseTo(
				calculateCostUSD(gpt55Event, pricing) * 2.5,
			);
		});

		it('does not multiply Codex costs from May 9 2026 onward', () => {
			const afterFast = {
				...event,
				timestamp: '2026-05-09T00:00:00.000Z',
				model: 'gpt-5.5',
			};

			expect(calculateCostUSDForEvent(afterFast, pricing)).toBeCloseTo(
				calculateCostUSD(afterFast, pricing),
			);
		});

		it('does not multiply Codex costs before the May 14 2026 fast restart', () => {
			const beforeRestart = {
				...event,
				timestamp: '2026-05-14T19:32:59.999Z',
				model: 'gpt-5.5',
			};

			expect(calculateCostUSDForEvent(beforeRestart, pricing)).toBeCloseTo(
				calculateCostUSD(beforeRestart, pricing),
			);
		});

		it('applies Codex fast multipliers from 8:33 pm London time on May 14 2026 onward', () => {
			const afterRestart = {
				...event,
				timestamp: '2026-05-14T19:33:00.000Z',
				model: 'gpt-5.5',
			};

			expect(calculateCostUSDForEvent(afterRestart, pricing)).toBeCloseTo(
				calculateCostUSD(afterRestart, pricing) * 2.5,
			);
		});
	});
}
