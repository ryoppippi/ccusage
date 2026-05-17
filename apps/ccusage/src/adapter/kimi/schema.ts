import * as v from 'valibot';

const tokenUsageSchema = v.object({
	input_other: v.optional(v.number()),
	output: v.optional(v.number()),
	input_cache_read: v.optional(v.number()),
	input_cache_creation: v.optional(v.number()),
});

const statusPayloadSchema = v.object({
	token_usage: v.optional(tokenUsageSchema),
	message_id: v.optional(v.string()),
});

const wireMessageSchema = v.object({
	type: v.string(),
	payload: v.optional(statusPayloadSchema),
});

export const kimiWireLineSchema = v.object({
	timestamp: v.optional(v.number()),
	type: v.optional(v.string()),
	message: v.optional(wireMessageSchema),
});

export type KimiWireLine = v.InferOutput<typeof kimiWireLineSchema>;

export type KimiUsageEntry = {
	timestamp: string;
	sessionId: string;
	model: string;
	provider: string;
	messageId?: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};
