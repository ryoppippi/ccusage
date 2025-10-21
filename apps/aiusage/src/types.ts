/**
 * @fileoverview Type definitions for unified AI usage tracking
 */

/**
 * AI service identifiers
 */
export type AIService = 'claude' | 'codex' | 'cursor' | 'copilot';

/**
 * Service availability status
 */
export type ServiceStatus = {
	service: AIService;
	available: boolean;
	dataPath?: string;
	error?: string;
};

/**
 * Unified usage data across all AI services
 */
export type UnifiedUsageData = {
	service: AIService;
	date: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreateTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	cost: number;
	models: string[];
};

/**
 * Aggregated usage across all services
 */
export type AggregatedUsage = {
	date: string;
	services: Map<AIService, UnifiedUsageData>;
	totalTokens: number;
	totalCost: number;
};

/**
 * Service configuration
 */
export type ServiceConfig = {
	enabled: boolean;
	dataPath?: string;
};
