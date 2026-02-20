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
	pricingResolution?: PricingResolution;
	pricingModel?: string;
};

export type PricingResolution = 'direct' | 'alias' | 'fuzzy' | 'fallback';

export type DailyUsageSummary = {
	date: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type MonthlyUsageSummary = {
	month: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type SessionUsageSummary = {
	sessionId: string;
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type ModelPricing = {
	inputCostPerMToken: number;
	cachedInputCostPerMToken: number;
	outputCostPerMToken: number;
	pricingResolution: PricingResolution;
	pricingModel: string;
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
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type MonthlyReportRow = {
	month: string;
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
