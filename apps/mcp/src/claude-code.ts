import type { calculateTotals } from 'ccusage/calculate-cost';
import type { LoadOptions } from 'ccusage/data-loader';
import { createTotalsObject } from 'ccusage/calculate-cost';
import { getClaudePaths } from 'ccusage/data-loader';
import { z } from 'zod';
import { DATE_FILTER_REGEX } from './consts.ts';

export const filterDateSchema = z.string()
	.regex(DATE_FILTER_REGEX, 'Date must be in YYYYMMDD format');

const modelBreakdownSchema = z.object({
	modelName: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	cost: z.number(),
});

const dailyUsageSchema = z.object({
	date: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	totalTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(z.string()),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

const sessionUsageSchema = z.object({
	sessionId: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	totalTokens: z.number(),
	totalCost: z.number(),
	lastActivity: z.string(),
	modelsUsed: z.array(z.string()),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

const monthlyUsageSchema = z.object({
	month: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	totalTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(z.string()),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

const blockUsageSchema = z.object({
	id: z.string(),
	startTime: z.string(),
	endTime: z.string().optional(),
	actualEndTime: z.string().optional(),
	isActive: z.boolean(),
	isGap: z.boolean(),
	entries: z.number(),
	tokenCounts: z.object({
		inputTokens: z.number(),
		outputTokens: z.number(),
		cacheCreationInputTokens: z.number(),
		cacheReadInputTokens: z.number(),
	}),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.array(z.string()),
	burnRate: z.number().nullable(),
	projection: z.unknown().nullable(),
});

export const dailyResponseSchema = {
	daily: z.array(dailyUsageSchema),
	totals: z.object({
		totalInputTokens: z.number().optional(),
		totalOutputTokens: z.number().optional(),
		totalCacheCreationTokens: z.number().optional(),
		totalCacheReadTokens: z.number().optional(),
		totalTokens: z.number().optional(),
		totalCost: z.number().optional(),
		modelsUsed: z.array(z.string()).optional(),
	}),
};

export const sessionResponseSchema = {
	sessions: z.array(sessionUsageSchema),
	totals: z.object({
		totalInputTokens: z.number().optional(),
		totalOutputTokens: z.number().optional(),
		totalCacheCreationTokens: z.number().optional(),
		totalCacheReadTokens: z.number().optional(),
		totalTokens: z.number().optional(),
		totalCost: z.number().optional(),
		modelsUsed: z.array(z.string()).optional(),
	}),
};

export const monthlyResponseSchema = {
	monthly: z.array(monthlyUsageSchema),
	totals: z.object({
		totalInputTokens: z.number().optional(),
		totalOutputTokens: z.number().optional(),
		totalCacheCreationTokens: z.number().optional(),
		totalCacheReadTokens: z.number().optional(),
		totalTokens: z.number().optional(),
		totalCost: z.number().optional(),
		modelsUsed: z.array(z.string()).optional(),
	}),
};

export const blocksResponseSchema = {
	blocks: z.array(blockUsageSchema),
};

export function transformUsageDataWithTotals<T>(
	data: T[],
	totals: ReturnType<typeof calculateTotals>,
	mapper: (item: T) => unknown,
	key: string,
): { [K in string]: unknown } & { totals: ReturnType<typeof createTotalsObject> } {
	return {
		[key]: data.map(mapper),
		totals: createTotalsObject(totals),
	};
}

export function defaultOptions(): LoadOptions {
	const paths = getClaudePaths();
	if (paths.length === 0) {
		throw new Error('No valid Claude path found. Ensure getClaudePaths() returns at least one valid path.');
	}
	return { claudePath: paths[0] } as const satisfies LoadOptions;
}
