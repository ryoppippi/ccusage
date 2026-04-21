/**
 * Token usage delta for a single event.
 */
export type TokenUsageDelta = {
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

/**
 * Token usage event loaded from Codebuff chat-messages files.
 */
export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: string;
	chatId: string;
	projectBasename: string;
	channel: string;
	model: string;
	credits: number;
};

/**
 * Metadata about a Codebuff chat session.
 */
export type ChatMetadata = {
	chatId: string;
	title: string;
	projectBasename: string;
	channel: string;
	cwd: string | null;
	firstTimestamp: string;
	lastTimestamp: string;
};

/**
 * Model usage summary with token counts and credits.
 */
export type ModelUsage = TokenUsageDelta & {
	credits: number;
};

/**
 * Model pricing (per-million token rates).
 */
export type ModelPricing = {
	inputCostPerMToken: number;
	cachedInputCostPerMToken: number;
	cacheCreationCostPerMToken: number;
	outputCostPerMToken: number;
};

/**
 * Pricing source interface used by commands.
 */
export type PricingSource = {
	getPricing: (model: string) => Promise<ModelPricing>;
};
