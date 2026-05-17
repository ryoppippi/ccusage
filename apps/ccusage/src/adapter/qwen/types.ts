export type QwenUsageEntry = {
	timestamp: string;
	sessionId: string;
	project: string | undefined;
	model: string;
	provider: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	reasoningTokens: number;
};
