/**
 * @fileoverview Data schemas and type definitions for Claude Code usage analysis
 *
 * This module contains all Zod schemas and TypeScript type definitions used
 * throughout the ccusage application for validating and typing usage data.
 *
 * @module _data-schemas
 */

import type { TupleToUnion } from 'type-fest';
import type { WEEK_DAYS } from './_consts.ts';
import { z } from 'zod';
import {
	activityDateSchema,
	dailyDateSchema,
	isoTimestampSchema,
	messageIdSchema,
	modelNameSchema,
	monthlyDateSchema,
	projectPathSchema,
	requestIdSchema,
	sessionIdSchema,
	versionSchema,
	weeklyDateSchema,
} from './_types.ts';

/**
 * Zod schema for validating Claude usage data from JSONL files
 */
export const usageDataSchema = z.object({
	cwd: z.string().optional(), // Claude Code version, optional for compatibility
	sessionId: sessionIdSchema.optional(), // Session ID for deduplication
	timestamp: isoTimestampSchema,
	version: versionSchema.optional(), // Claude Code version
	message: z.object({
		usage: z.object({
			input_tokens: z.number(),
			output_tokens: z.number(),
			cache_creation_input_tokens: z.number().optional(),
			cache_read_input_tokens: z.number().optional(),
		}),
		model: modelNameSchema.optional(), // Model is inside message object
		id: messageIdSchema.optional(), // Message ID for deduplication
		content: z.array(z.object({
			text: z.string().optional(),
		})).optional(),
	}),
	costUSD: z.number().optional(), // Made optional for new schema
	requestId: requestIdSchema.optional(), // Request ID for deduplication
	isApiErrorMessage: z.boolean().optional(),
});

/**
 * Type definition for Claude usage data entries from JSONL files
 */
export type UsageData = z.infer<typeof usageDataSchema>;

/**
 * Zod schema for transcript usage data from Claude messages
 */
export const transcriptUsageSchema = z.object({
	input_tokens: z.number().optional(),
	cache_creation_input_tokens: z.number().optional(),
	cache_read_input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
});

/**
 * Zod schema for transcript message data
 */
export const transcriptMessageSchema = z.object({
	type: z.string().optional(),
	message: z.object({
		usage: transcriptUsageSchema.optional(),
	}).optional(),
});

/**
 * Zod schema for model-specific usage breakdown data
 */
export const modelBreakdownSchema = z.object({
	modelName: modelNameSchema,
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	cost: z.number(),
});

/**
 * Type definition for model-specific usage breakdown
 */
export type ModelBreakdown = z.infer<typeof modelBreakdownSchema>;

/**
 * Zod schema for daily usage aggregation data
 */
export const dailyUsageSchema = z.object({
	date: dailyDateSchema, // YYYY-MM-DD format
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for daily usage aggregation
 */
export type DailyUsage = z.infer<typeof dailyUsageSchema>;

/**
 * Zod schema for session-based usage aggregation data
 */
export const sessionUsageSchema = z.object({
	sessionId: sessionIdSchema,
	projectPath: projectPathSchema,
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	lastActivity: activityDateSchema,
	versions: z.array(versionSchema), // List of unique versions used in this session
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

/**
 * Type definition for session-based usage aggregation
 */
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

/**
 * Zod schema for monthly usage aggregation data
 */
export const monthlyUsageSchema = z.object({
	month: monthlyDateSchema, // YYYY-MM format
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for monthly usage aggregation
 */
export type MonthlyUsage = z.infer<typeof monthlyUsageSchema>;

/**
 * Zod schema for weekly usage aggregation data
 */
export const weeklyUsageSchema = z.object({
	week: weeklyDateSchema, // YYYY-MM-DD format
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for weekly usage aggregation
 */
export type WeeklyUsage = z.infer<typeof weeklyUsageSchema>;

/**
 * Zod schema for bucket usage aggregation data
 */
export const bucketUsageSchema = z.object({
	bucket: z.union([weeklyDateSchema, monthlyDateSchema]), // WeeklyDate or MonthlyDate
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(modelNameSchema),
	modelBreakdowns: z.array(modelBreakdownSchema),
	project: z.string().optional(), // Project name when groupByProject is enabled
});

/**
 * Type definition for bucket usage aggregation
 */
export type BucketUsage = z.infer<typeof bucketUsageSchema>;

/**
 * Result of glob operation with base directory information
 */
export type GlobResult = {
	file: string;
	baseDir: string;
};

/**
 * Date range filter for limiting usage data by date
 */
export type DateFilter = {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
};

type WeekDay = TupleToUnion<typeof WEEK_DAYS>;

/**
 * Configuration options for loading usage data
 */
export type LoadOptions = {
	claudePath?: string; // Custom path to Claude data directory
	mode?: import('./_types.ts').CostMode; // Cost calculation mode
	order?: import('./_types.ts').SortOrder; // Sort order for dates
	offline?: boolean; // Use offline mode for pricing
	sessionDurationHours?: number; // Session block duration in hours
	groupByProject?: boolean; // Group data by project instead of aggregating
	project?: string; // Filter to specific project name
	startOfWeek?: WeekDay; // Start of week for weekly aggregation
	timezone?: string; // Timezone for date grouping (e.g., 'UTC', 'America/New_York'). Defaults to system timezone
	locale?: string; // Locale for date/time formatting (e.g., 'en-US', 'ja-JP'). Defaults to 'en-US'
} & DateFilter;
