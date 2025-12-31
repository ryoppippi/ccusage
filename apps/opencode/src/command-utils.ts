import type { ModelUsage } from './_types.ts';
import { sort } from 'fast-sort';

export function formatModelsList(models: Record<string, ModelUsage>): string[] {
	return sort(Object.entries(models))
		.asc(([model]) => model)
		.map(([model]) => model);
}

export function modelsMapToRecord(models: Map<string, ModelUsage>): Record<string, ModelUsage> {
	const record: Record<string, ModelUsage> = {};
	for (const [model, usage] of models) {
		record[model] = usage;
	}
	return record;
}
