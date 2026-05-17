import * as v from 'valibot';

const usageLedgerEventSchema = v.object({
	timestamp: v.string(),
	model: v.string(),
	credits: v.number(),
	tokens: v.object({
		input: v.optional(v.number()),
		output: v.optional(v.number()),
	}),
	operationType: v.optional(v.string()),
	fromMessageId: v.optional(v.number()),
	toMessageId: v.optional(v.number()),
});

const messageUsageSchema = v.object({
	cacheCreationInputTokens: v.optional(v.number()),
	cacheReadInputTokens: v.optional(v.number()),
});

const messageSchema = v.object({
	role: v.string(),
	messageId: v.number(),
	usage: v.optional(messageUsageSchema),
});

export const ampThreadSchema = v.object({
	id: v.string(),
	messages: v.optional(v.array(messageSchema)),
	usageLedger: v.optional(
		v.object({
			events: v.optional(v.array(usageLedgerEventSchema)),
		}),
	),
});

export type AmpThread = v.InferOutput<typeof ampThreadSchema>;
export type AmpLedgerEvent = v.InferOutput<typeof usageLedgerEventSchema>;
export type AmpMessage = v.InferOutput<typeof messageSchema>;

export type AmpUsageEvent = {
	timestamp: string;
	threadId: string;
	model: string;
	credits: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
};
