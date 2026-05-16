/**
 * Token usage delta for a single event
 */
export type TokenUsageDelta = {
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

/**
 * Token usage event loaded from Amp thread files
 */
export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: string;
	threadId: string;
	model: string;
	credits: number;
	operationType: string;
};

/**
 * Model usage summary with token counts
 */
export type ModelUsage = TokenUsageDelta & {
	credits: number;
};

/**
 * Daily usage summary
 */
export type DailyUsageSummary = {
	date: string;
	firstTimestamp: string;
	costUSD: number;
	credits: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

/**
 * Monthly usage summary
 */
export type MonthlyUsageSummary = {
	month: string;
	firstTimestamp: string;
	costUSD: number;
	credits: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

/**
 * Session (thread) usage summary
 */
export type SessionUsageSummary = {
	threadId: string;
	title: string;
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
	credits: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

/**
 * Model pricing information
 */
export type ModelPricing = {
	inputCostPerMToken: number;
	cachedInputCostPerMToken: number;
	cacheCreationCostPerMToken: number;
	outputCostPerMToken: number;
};

/**
 * Pricing source interface
 */
export type PricingSource = {
	getPricing: (model: string) => Promise<ModelPricing>;
};

/**
 * Daily report row for JSON output
 */
export type DailyReportRow = {
	date: string;
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUSD: number;
	credits: number;
	models: Record<string, ModelUsage>;
};

/**
 * Monthly report row for JSON output
 */
export type MonthlyReportRow = {
	month: string;
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUSD: number;
	credits: number;
	models: Record<string, ModelUsage>;
};

/**
 * Session report row for JSON output
 */
export type SessionReportRow = {
	threadId: string;
	title: string;
	lastActivity: string;
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUSD: number;
	credits: number;
	models: Record<string, ModelUsage>;
};
