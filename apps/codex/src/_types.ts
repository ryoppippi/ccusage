export type TokenUsageDelta = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

export type SessionSource = {
	account: string;
	directory: string;
};

export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: string;
	sessionId: string;
	account?: string;
	model?: string;
	isFallbackModel?: boolean;
};

export type ModelUsage = TokenUsageDelta & {
	isFallback?: boolean;
};

export type DailyUsageSummary = {
	date: string;
	account?: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type MonthlyUsageSummary = {
	month: string;
	account?: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type SessionUsageSummary = {
	sessionId: string;
	account?: string;
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
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
	account?: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type MonthlyReportRow = {
	month: string;
	account?: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type SessionReportRow = {
	sessionId: string;
	account?: string;
	lastActivity: string;
	sessionFile: string;
	directory: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};
