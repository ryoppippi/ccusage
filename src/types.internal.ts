import type { TupleToUnion } from 'type-fest';
import { z } from 'zod';

/**
 * Branded Zod schemas for type safety using Zod's built-in brand functionality
 */

// Core identifier schemas
export const modelNameSchema = z.string()
	.min(1, 'Model name cannot be empty')
	.brand<'ModelName'>();

export const sessionIdSchema = z.string()
	.min(1, 'Session ID cannot be empty')
	.brand<'SessionId'>();

export const requestIdSchema = z.string()
	.min(1, 'Request ID cannot be empty')
	.brand<'RequestId'>();

export const messageIdSchema = z.string()
	.min(1, 'Message ID cannot be empty')
	.brand<'MessageId'>();

// Date and timestamp schemas
export const isoTimestampSchema = z.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 'Invalid ISO timestamp')
	.brand<'ISOTimestamp'>();

export const dailyDateSchema = z.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
	.brand<'DailyDate'>();

export const activityDateSchema = z.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
	.brand<'ActivityDate'>();

export const monthlyDateSchema = z.string()
	.regex(/^\d{4}-\d{2}$/, 'Date must be in YYYY-MM format')
	.brand<'MonthlyDate'>();

export const filterDateSchema = z.string()
	.regex(/^\d{8}$/, 'Date must be in YYYYMMDD format')
	.brand<'FilterDate'>();

// Other domain-specific schemas
export const projectPathSchema = z.string()
	.min(1, 'Project path cannot be empty')
	.brand<'ProjectPath'>();

export const versionSchema = z.string()
	.regex(/^\d+\.\d+\.\d+/, 'Invalid version format')
	.brand<'Version'>();

/**
 * Inferred branded types from schemas
 */
export type ModelName = z.infer<typeof modelNameSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type ISOTimestamp = z.infer<typeof isoTimestampSchema>;
export type DailyDate = z.infer<typeof dailyDateSchema>;
export type ActivityDate = z.infer<typeof activityDateSchema>;
export type MonthlyDate = z.infer<typeof monthlyDateSchema>;
export type FilterDate = z.infer<typeof filterDateSchema>;
export type ProjectPath = z.infer<typeof projectPathSchema>;
export type Version = z.infer<typeof versionSchema>;

/**
 * Helper functions to create branded values by parsing and validating input strings
 * These functions should be used when converting plain strings to branded types
 */
export const createModelName = (value: string): ModelName => modelNameSchema.parse(value);
export const createSessionId = (value: string): SessionId => sessionIdSchema.parse(value);
export const createRequestId = (value: string): RequestId => requestIdSchema.parse(value);
export const createMessageId = (value: string): MessageId => messageIdSchema.parse(value);
export const createISOTimestamp = (value: string): ISOTimestamp => isoTimestampSchema.parse(value);
export const createDailyDate = (value: string): DailyDate => dailyDateSchema.parse(value);
export const createActivityDate = (value: string): ActivityDate => activityDateSchema.parse(value);
export const createMonthlyDate = (value: string): MonthlyDate => monthlyDateSchema.parse(value);
export const createFilterDate = (value: string): FilterDate => filterDateSchema.parse(value);
export const createProjectPath = (value: string): ProjectPath => projectPathSchema.parse(value);
export const createVersion = (value: string): Version => versionSchema.parse(value);

/**
 * Legacy schema for backward compatibility
 * @deprecated Use filterDateSchema instead for better type safety
 */
export const dateSchema = z.string().regex(/^\d{8}$/, 'Date must be in YYYYMMDD format');

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
 * Zod schema for model pricing information from LiteLLM
 */
export const modelPricingSchema = z.object({
	input_cost_per_token: z.number().optional(),
	output_cost_per_token: z.number().optional(),
	cache_creation_input_token_cost: z.number().optional(),
	cache_read_input_token_cost: z.number().optional(),
});

/**
 * Type definition for model pricing information
 */
export type ModelPricing = z.infer<typeof modelPricingSchema>;
