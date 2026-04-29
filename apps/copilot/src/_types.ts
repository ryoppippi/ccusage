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
