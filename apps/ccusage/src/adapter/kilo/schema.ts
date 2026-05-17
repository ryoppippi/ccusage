import * as v from 'valibot';

export const kiloModelNameSchema = v.pipe(v.string(), v.minLength(1), v.brand('KiloModelName'));
export const kiloSessionIdSchema = v.pipe(v.string(), v.minLength(1), v.brand('KiloSessionId'));

export const kiloTokensSchema = v.object({
	input: v.number(),
	output: v.number(),
	reasoning: v.optional(v.number()),
	cache: v.object({
		read: v.number(),
		write: v.number(),
	}),
});

export const kiloMessageSchema = v.object({
	id: v.optional(v.string()),
	session_id: v.optional(kiloSessionIdSchema),
	role: v.string(),
	providerID: v.optional(v.string()),
	modelID: v.optional(kiloModelNameSchema),
	time: v.optional(
		v.object({
			created: v.optional(v.number()),
			completed: v.optional(v.number()),
		}),
	),
	tokens: v.optional(kiloTokensSchema),
	cost: v.optional(v.number()),
	agent: v.optional(v.string()),
	mode: v.optional(v.string()),
});

export const kiloDbMessageRowSchema = v.object({
	id: v.string(),
	session_id: v.string(),
	data: v.string(),
});

export type KiloMessage = v.InferOutput<typeof kiloMessageSchema>;
export type KiloTokens = v.InferOutput<typeof kiloTokensSchema>;

export type KiloUsageEntry = {
	timestamp: Date;
	sessionID: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
		reasoningTokens: number;
	};
	model: string;
	providerID: string;
	costUSD: number | null;
	agent: string | null;
};

export type KiloMessageResult = {
	id: string;
	entry: KiloUsageEntry;
};
