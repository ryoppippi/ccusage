import type { TupleToUnion } from 'type-fest';
import * as v from 'valibot';

/**
 * Valibot schema for validating date strings in YYYYMMDD format
 */
export const dateSchema = v.pipe(
	v.string(),
	v.regex(/^\d{8}$/, 'Date must be in YYYYMMDD format'),
);

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
 * Valibot schema for model pricing information from LiteLLM
 */
export const ModelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
});

/**
 * Type definition for model pricing information
 */
export type ModelPricing = v.InferOutput<typeof ModelPricingSchema>;
