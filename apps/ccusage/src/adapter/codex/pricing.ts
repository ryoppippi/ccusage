import type { LiteLLMModelPricing, LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { CodexModelUsage, CodexSpeed } from './types.ts';
import path from 'node:path';
import { readTextFile } from '@ccusage/internal/fs';
import { Result } from '@praha/byethrow';
import { getCodexHomePaths } from './paths.ts';
import { prefetchCodexPricing } from './pricing-macro.ts' with { type: 'macro' };

const MILLION = 1_000_000;
export const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const PREFETCHED_CODEX_PRICING = prefetchCodexPricing();
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([
	['gpt-5-codex', 'gpt-5'],
	['gpt-5.3-codex', 'gpt-5.2-codex'],
]);
const CODEX_FAST_FALLBACK_MULTIPLIER = 2;

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

export async function loadOfflineCodexPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	return PREFETCHED_CODEX_PRICING;
}

function hasNonZeroTokenPricing(pricing: LiteLLMModelPricing): boolean {
	return (
		(pricing.input_cost_per_token ?? 0) > 0 ||
		(pricing.output_cost_per_token ?? 0) > 0 ||
		(pricing.cache_read_input_token_cost ?? 0) > 0
	);
}

export function calculateCodexCostUSD(
	usage: CodexModelUsage,
	pricing: {
		inputCostPerMToken: number;
		cachedInputCostPerMToken: number;
		outputCostPerMToken: number;
	},
): number {
	const nonCachedInputTokens = Math.max(usage.inputTokens - usage.cachedInputTokens, 0);
	return (
		(nonCachedInputTokens / MILLION) * pricing.inputCostPerMToken +
		(usage.cachedInputTokens / MILLION) * pricing.cachedInputCostPerMToken +
		(usage.outputTokens / MILLION) * pricing.outputCostPerMToken
	);
}

function normalizeCodexSpeed(value: string | undefined): 'auto' | CodexSpeed {
	if (value == null || value === '' || value === 'auto') {
		return 'auto';
	}
	if (value === 'standard' || value === 'fast') {
		return value;
	}
	throw new Error(`Invalid speed option: ${value}. Use auto, standard, or fast.`);
}

export async function resolveCodexSpeed(requested?: string): Promise<CodexSpeed> {
	const speed = normalizeCodexSpeed(requested);
	if (speed !== 'auto') {
		return speed;
	}
	for (const configPath of getCodexHomePaths().map((codexHome) =>
		path.join(codexHome, 'config.toml'),
	)) {
		const result = await Result.try({
			try: readTextFile(configPath),
			catch: (error) => error,
		});
		if (
			!Result.isFailure(result) &&
			/(?:^|\n)\s*service_tier\s*=\s*["']?(?:fast|priority)["']?/iu.test(result.value)
		) {
			return 'fast';
		}
	}
	return 'standard';
}

export async function getCodexPricing(
	model: string,
	fetcher: LiteLLMPricingFetcher,
	speed: CodexSpeed,
): Promise<{
	inputCostPerMToken: number;
	cachedInputCostPerMToken: number;
	outputCostPerMToken: number;
}> {
	const directLookup = await fetcher.getModelPricing(model);
	if (Result.isFailure(directLookup)) {
		throw directLookup.error;
	}

	let pricing = directLookup.value;
	const alias = CODEX_MODEL_ALIASES_MAP.get(model);
	if (alias != null && (pricing == null || !hasNonZeroTokenPricing(pricing))) {
		const aliasLookup = await fetcher.getModelPricing(alias);
		if (Result.isFailure(aliasLookup)) {
			throw aliasLookup.error;
		}
		if (aliasLookup.value != null && hasNonZeroTokenPricing(aliasLookup.value)) {
			pricing = aliasLookup.value;
		}
	}

	if (pricing == null) {
		return {
			inputCostPerMToken: 0,
			cachedInputCostPerMToken: 0,
			outputCostPerMToken: 0,
		};
	}

	const speedMultiplier =
		speed === 'fast'
			? (pricing.provider_specific_entry?.fast ?? CODEX_FAST_FALLBACK_MULTIPLIER)
			: 1;
	return {
		inputCostPerMToken: toPerMillion(pricing.input_cost_per_token) * speedMultiplier,
		cachedInputCostPerMToken:
			toPerMillion(pricing.cache_read_input_token_cost, pricing.input_cost_per_token) *
			speedMultiplier,
		outputCostPerMToken: toPerMillion(pricing.output_cost_per_token) * speedMultiplier,
	};
}
