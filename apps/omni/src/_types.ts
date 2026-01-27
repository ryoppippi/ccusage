import type { TupleToUnion } from 'type-fest';

/**
 * Supported data sources (v1)
 */
export const Sources = ['claude', 'codex', 'opencode', 'pi'] as const;
export type Source = TupleToUnion<typeof Sources>;

/**
 * Unified token usage (normalized across all sources)
 *
 * IMPORTANT: Token semantics differ by source - totals are SOURCE-FAITHFUL:
 * - Claude/OpenCode/Pi: totalTokens = input + output + cacheRead + cacheCreation
 * - Codex: totalTokens = input + output (cache is subset of input, NOT additive)
 *
 * The normalizers preserve each source's native totalTokens calculation.
 * Grand totals should show COST ONLY since token semantics are not comparable.
 */
export type UnifiedTokenUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
};

/**
 * Unified daily usage entry
 */
export type UnifiedDailyUsage = UnifiedTokenUsage & {
	source: Source;
	date: string; // YYYY-MM-DD
	costUSD: number;
	models: string[];
};

/**
 * Unified monthly usage entry
 */
export type UnifiedMonthlyUsage = UnifiedTokenUsage & {
	source: Source;
	month: string; // YYYY-MM
	costUSD: number;
	models: string[];
};

/**
 * Unified session usage entry
 */
export type UnifiedSessionUsage = UnifiedTokenUsage & {
	source: Source;
	sessionId: string;
	displayName: string; // Session name or project path
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
	models: string[];
};

/**
 * Aggregated totals by source
 */
export type SourceTotals = {
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUSD: number;
};

/**
 * Combined report totals
 * NOTE: Only costUSD is summed across sources. Token totals are per-source only.
 */
export type CombinedTotals = {
	costUSD: number;
	bySource: SourceTotals[];
};
