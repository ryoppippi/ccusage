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

export const ModelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
});

export type ModelPricing = v.InferOutput<typeof ModelPricingSchema>;
