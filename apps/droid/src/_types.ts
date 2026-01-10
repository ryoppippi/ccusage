export type ModelIdSource = 'tag' | 'settings' | 'session' | 'unknown';

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

export type ModelUsage = {
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
};

export type PricingResult = {
	costUSD: number;
	usedPricingModel: string;
};

export type PricingSource = {
	calculateCost: (pricingModel: string, usage: ModelUsage) => Promise<PricingResult>;
};

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
