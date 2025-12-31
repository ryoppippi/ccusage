export type TokenUsageDelta = {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
};

export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: number;
	sessionId: string;
	projectId: string;
	modelId: string;
	providerId: string;
	cost: number;
};

export type ModelUsage = TokenUsageDelta & {
	cost: number;
};

export type DailyUsageSummary = {
	date: string;
	firstTimestamp: number;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type MonthlyUsageSummary = {
	month: string;
	firstTimestamp: number;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type SessionUsageSummary = {
	sessionId: string;
	projectId: string;
	firstTimestamp: number;
	lastTimestamp: number;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type DailyReportRow = {
	date: string;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type MonthlyReportRow = {
	month: string;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type SessionReportRow = {
	sessionId: string;
	projectId: string;
	lastActivity: string;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type ModelPricing = {
	inputCostPerMToken: number;
	outputCostPerMToken: number;
	cacheReadCostPerMToken: number;
	cacheWriteCostPerMToken: number;
};

export type PricingSource = {
	getPricing: (model: string) => Promise<ModelPricing | null>;
};
