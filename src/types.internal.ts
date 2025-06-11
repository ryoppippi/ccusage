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
