export type GeminiUsageEvent = {
	timestamp: string;
	sessionId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	toolTokens: number;
	totalTokens: number;
};
