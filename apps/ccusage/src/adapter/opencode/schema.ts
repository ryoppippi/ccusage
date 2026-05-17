import * as v from 'valibot';

export const openCodeModelNameSchema = v.pipe(v.string(), v.minLength(1), v.brand('ModelName'));
export const openCodeSessionIdSchema = v.pipe(v.string(), v.minLength(1), v.brand('SessionId'));

export const openCodeTokensSchema = v.object({
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	reasoning: v.optional(v.number()),
	cache: v.optional(
		v.object({
			read: v.optional(v.number()),
			write: v.optional(v.number()),
		}),
	),
});

export const openCodeMessageSchema = v.object({
	id: v.string(),
	sessionID: v.optional(openCodeSessionIdSchema),
	providerID: v.optional(v.string()),
	modelID: v.optional(openCodeModelNameSchema),
	time: v.object({
		created: v.optional(v.number()),
		completed: v.optional(v.number()),
	}),
	tokens: v.optional(openCodeTokensSchema),
	cost: v.optional(v.number()),
});

export const openCodeDbMessageRowSchema = v.object({
	id: v.string(),
	session_id: v.string(),
	data: v.string(),
});

export type OpenCodeMessage = v.InferOutput<typeof openCodeMessageSchema>;
export type OpenCodeTokens = v.InferOutput<typeof openCodeTokensSchema>;

export type OpenCodeUsageEntry = {
	timestamp: Date;
	sessionID: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	model: string;
	providerID: string;
	costUSD: number | null;
};

export type OpenCodeMessageResult = {
	id: string;
	entry: OpenCodeUsageEntry;
};
