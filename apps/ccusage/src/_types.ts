import type { TupleToUnion } from 'type-fest';
import * as v from 'valibot';

/**
 * Branded Valibot schemas for type safety using brand markers.
 */

// Core identifier schemas
export const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);

export const sessionIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Session ID cannot be empty'),
	v.brand('SessionId'),
);

export const requestIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Request ID cannot be empty'),
	v.brand('RequestId'),
);

export const messageIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Message ID cannot be empty'),
	v.brand('MessageId'),
);

// Date and timestamp schemas
const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const isoTimestampSchema = v.pipe(
	v.string(),
	v.regex(isoTimestampRegex, 'Invalid ISO timestamp'),
	v.brand('ISOTimestamp'),
);

const yyyymmddRegex = /^\d{4}-\d{2}-\d{2}$/;
export const dailyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('DailyDate'),
);

export const activityDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('ActivityDate'),
);

const yyyymmRegex = /^\d{4}-\d{2}$/;
export const monthlyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmRegex, 'Date must be in YYYY-MM format'),
	v.brand('MonthlyDate'),
);

export const weeklyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('WeeklyDate'),
);

const filterDateRegex = /^\d{8}$/;
export const filterDateSchema = v.pipe(
	v.string(),
	v.regex(filterDateRegex, 'Date must be in YYYYMMDD format'),
	v.brand('FilterDate'),
);

// Other domain-specific schemas
export const projectPathSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Project path cannot be empty'),
	v.brand('ProjectPath'),
);

const versionRegex = /^\d+\.\d+\.\d+/;
export const versionSchema = v.pipe(
	v.string(),
	v.regex(versionRegex, 'Invalid version format'),
	v.brand('Version'),
);

/**
 * Inferred branded types from schemas
 */
export type ModelName = v.InferOutput<typeof modelNameSchema>;
export type SessionId = v.InferOutput<typeof sessionIdSchema>;
export type RequestId = v.InferOutput<typeof requestIdSchema>;
export type MessageId = v.InferOutput<typeof messageIdSchema>;
export type ISOTimestamp = v.InferOutput<typeof isoTimestampSchema>;
export type DailyDate = v.InferOutput<typeof dailyDateSchema>;
export type ActivityDate = v.InferOutput<typeof activityDateSchema>;
export type MonthlyDate = v.InferOutput<typeof monthlyDateSchema>;
export type WeeklyDate = v.InferOutput<typeof weeklyDateSchema>;
export type Bucket = MonthlyDate | WeeklyDate;
export type FilterDate = v.InferOutput<typeof filterDateSchema>;
export type ProjectPath = v.InferOutput<typeof projectPathSchema>;
export type Version = v.InferOutput<typeof versionSchema>;

/**
 * Helper functions to create branded values by parsing and validating input strings
 * These functions should be used when converting plain strings to branded types
 */
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
export const createSessionId = (value: string): SessionId => v.parse(sessionIdSchema, value);
export const createRequestId = (value: string): RequestId => v.parse(requestIdSchema, value);
export const createMessageId = (value: string): MessageId => v.parse(messageIdSchema, value);
export const createISOTimestamp = (value: string): ISOTimestamp => v.parse(isoTimestampSchema, value);
export const createDailyDate = (value: string): DailyDate => v.parse(dailyDateSchema, value);
export const createActivityDate = (value: string): ActivityDate => v.parse(activityDateSchema, value);
export const createMonthlyDate = (value: string): MonthlyDate => v.parse(monthlyDateSchema, value);
export const createWeeklyDate = (value: string): WeeklyDate => v.parse(weeklyDateSchema, value);
export const createFilterDate = (value: string): FilterDate => v.parse(filterDateSchema, value);
export const createProjectPath = (value: string): ProjectPath => v.parse(projectPathSchema, value);
export const createVersion = (value: string): Version => v.parse(versionSchema, value);

export function createBucket(value: string): Bucket {
	const weeklyResult = v.safeParse(weeklyDateSchema, value);
	if (weeklyResult.success) {
		return weeklyResult.output;
	}
	return createMonthlyDate(value);
};

/**
 * Available cost calculation modes
 * - auto: Use pre-calculated costs when available, otherwise calculate from tokens
 * - calculate: Always calculate costs from token counts using model pricing
 * - display: Always use pre-calculated costs, show 0 for missing costs
 */
export const CostModes = ['auto', 'calculate', 'display'] as const;

/**
 * Union type for cost calculation modes
 */
export type CostMode = TupleToUnion<typeof CostModes>;

/**
 * Available sort orders for data presentation
 */
export const SortOrders = ['desc', 'asc'] as const;

/**
 * Union type for sort order options
 */
export type SortOrder = TupleToUnion<typeof SortOrders>;

/**
 * Valibot schema for Claude Code statusline hook JSON data
 */
export const statuslineHookJsonSchema = v.object({
	session_id: v.string(),
	transcript_path: v.string(),
	cwd: v.string(),
	model: v.object({
		id: v.string(),
		display_name: v.string(),
	}),
	workspace: v.object({
		current_dir: v.string(),
		project_dir: v.string(),
	}),
	version: v.optional(v.string()),
	cost: v.optional(v.object({
		total_cost_usd: v.number(),
		total_duration_ms: v.optional(v.number()),
		total_api_duration_ms: v.optional(v.number()),
		total_lines_added: v.optional(v.number()),
		total_lines_removed: v.optional(v.number()),
	})),
	context_window: v.optional(v.object({
		total_input_tokens: v.number(),
		total_output_tokens: v.optional(v.number()),
		context_window_size: v.number(),
	})),
});

/**
 * Type definition for Claude Code statusline hook JSON data
 */
export type StatuslineHookJson = v.InferOutput<typeof statuslineHookJsonSchema>;

/**
 * Type definition for transcript usage data from Claude messages
 */
