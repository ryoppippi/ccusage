/**
 * Token usage delta for a single event
 */
export type TokenUsageDelta = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
};

/**
 * Token usage event extracted from a session.shutdown's modelMetrics
 */
export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: string;
	sessionId: string;
	model: string;
	requestCount: number;
	premiumRequestCost: number;
};

/**
 * Session metadata extracted from session.start and workspace.yaml
 */
export type SessionMetadata = {
	sessionId: string;
	cwd: string;
	gitRoot?: string;
	repository?: string;
	branch?: string;
	copilotVersion: string;
	startTime: string;
};

/**
 * Model usage summary with token counts
 */
export type ModelUsage = TokenUsageDelta & {
	requestCount: number;
	premiumRequestCost: number;
};

/**
 * Daily usage summary
 */
export type DailyUsageSummary = {
	date: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

/**
 * Monthly usage summary
 */
export type MonthlyUsageSummary = {
	month: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

/**
 * Session usage summary
 */
export type SessionUsageSummary = {
	sessionId: string;
	repository: string;
	cwd: string;
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
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
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

/**
 * Monthly report row for JSON output
 */
export type MonthlyReportRow = {
	month: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

/**
 * Session report row for JSON output
 */
export type SessionReportRow = {
	sessionId: string;
	repository: string;
	cwd: string;
	lastActivity: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};
