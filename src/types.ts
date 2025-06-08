import * as v from 'valibot';

export const dateSchema = v.pipe(
	v.string(),
	v.regex(/^\d{8}$/, 'Date must be in YYYYMMDD format'),
);

export const CostModes = ['auto', 'calculate', 'display'] as const;
export type CostMode = (typeof CostModes)[number];

export const SortOrders = ['desc', 'asc'] as const;
export type SortOrder = (typeof SortOrders)[number];
