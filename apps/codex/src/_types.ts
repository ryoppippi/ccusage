export type TokenUsageDelta = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: string;
	sessionId: string;
	model?: string;
	isFallbackModel?: boolean;
};

export type ModelUsage = TokenUsageDelta & {
	isFallback?: boolean;
};

export type DailyUsageSummary = {
	date: string;
	firstTimestamp: string;
	totalCost: number;
	costUSD: number; // Legacy field, use totalCost instead
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type MonthlyUsageSummary = {
	month: string;
	firstTimestamp: string;
	totalCost: number;
	costUSD: number; // Legacy field, use totalCost instead
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type SessionUsageSummary = {
	sessionId: string;
	firstTimestamp: string;
	lastTimestamp: string;
	totalCost: number;
	costUSD: number; // Legacy field, use totalCost instead
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type ModelPricing = {
	inputCostPerMToken: number;
	cachedInputCostPerMToken: number;
	outputCostPerMToken: number;
};

export type PricingLookupResult = {
	model: string;
	pricing: ModelPricing;
};

export type PricingSource = {
	getPricing: (model: string) => Promise<ModelPricing>;
};

export type DailyReportRow = {
	date: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	totalCost: number;
	costUSD: number; // Legacy field, use totalCost instead
	models: Record<string, ModelUsage>;
};

export type MonthlyReportRow = {
	month: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	totalCost: number;
	costUSD: number; // Legacy field, use totalCost instead
	models: Record<string, ModelUsage>;
};

export type SessionReportRow = {
	sessionId: string;
	lastActivity: string;
	sessionFile: string;
	directory: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	totalCost: number;
	costUSD: number; // Legacy field, use totalCost instead
	models: Record<string, ModelUsage>;
};
