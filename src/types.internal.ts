import type { TupleToUnion } from 'type-fest';
import * as v from 'valibot';

export const dateSchema = v.pipe(
	v.string(),
	v.regex(/^\d{8}$/, 'Date must be in YYYYMMDD format'),
);

export const CostModes = ['auto', 'calculate', 'display'] as const;
export type CostMode = TupleToUnion<typeof CostModes>;

export const SortOrders = ['desc', 'asc'] as const;
export type SortOrder = TupleToUnion<typeof SortOrders>;

export const SessionWindowSchema = v.object({
	windowId: v.string(), // Format: YYYY-MM-DD-HH (start of 5-hour window)
	startTime: v.string(), // ISO timestamp of first message in window
	endTime: v.string(), // ISO timestamp of last message in window
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	messageCount: v.number(), // Number of messages in this window
	conversationCount: v.number(), // Number of unique conversations in this window
});

export type SessionWindow = v.InferOutput<typeof SessionWindowSchema>;

export const SessionWindowStatsSchema = v.object({
	month: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}$/), // YYYY-MM format
	),
	totalSessions: v.number(), // Total number of 5-hour windows with activity
	remainingSessions: v.number(), // 50 - totalSessions (Max plan limit)
	utilizationPercent: v.number(), // (totalSessions / 50) * 100
	totalCost: v.number(),
	totalTokens: v.number(),
	averageCostPerSession: v.number(),
	averageTokensPerSession: v.number(),
	windows: v.array(SessionWindowSchema),
});

export type SessionWindowStats = v.InferOutput<typeof SessionWindowStatsSchema>;
