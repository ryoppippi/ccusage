/**
 * @fileoverview Shared types for the Factory Droid usage pipeline.
 */

/**
 * Indicates where a model identifier was resolved from.
 */
export type ModelIdSource = 'tag' | 'settings' | 'session' | 'unknown';

/**
 * A single token usage event derived from Factory Droid logs.
 */
export type TokenUsageEvent = {
	timestamp: string;
	sessionId: string;
	projectKey: string;
	modelId: string;
	modelIdSource: ModelIdSource;
	pricingModel: string;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
};

/**
 * Token usage structure used for aggregation and pricing.
 */
export type ModelUsage = {
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
};

/**
 * Result of a pricing calculation.
 */
export type PricingResult = {
	costUSD: number;
	usedPricingModel: string;
};

/**
 * Pricing provider interface used by report builders.
 */
export type PricingSource = {
	calculateCost: (pricingModel: string, usage: ModelUsage) => Promise<PricingResult>;
};

/**
 * A single row in the daily report.
 */
export type DailyReportRow = {
	date: string;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUSD: number;
	modelsUsed: string[];
};

/**
 * A single row in the monthly report.
 */
export type MonthlyReportRow = {
	month: string;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUSD: number;
	modelsUsed: string[];
};

/**
 * A single row in the session report.
 */
export type SessionReportRow = {
	directory: string;
	sessionId: string;
	modelsUsed: string[];
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUSD: number;
	lastActivity: string;
};
