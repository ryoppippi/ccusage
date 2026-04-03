import { sort } from 'fast-sort';
import { UNKNOWN_PROJECT_LABEL } from './project-utils.ts';

export type UsageGroup = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export function splitUsageTokens(usage: UsageGroup): {
	inputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = Math.max(usage.outputTokens, 0);
	const rawReasoning = usage.reasoningOutputTokens ?? 0;
	const reasoningTokens = Math.max(0, Math.min(rawReasoning, outputTokens));

	return {
		inputTokens,
		reasoningTokens,
		cacheReadTokens,
		outputTokens,
	};
}

export function formatModelsList(
	models: Record<string, { totalTokens: number; isFallback?: boolean }>,
): string[] {
	return sort(Object.entries(models))
		.asc(([model]) => model)
		.map(([model, data]) => (data.isFallback === true ? `${model} (fallback)` : model));
}

export function groupRowsByProject<T extends { project?: string }>(rows: T[]): Record<string, T[]> {
	const projects: Record<string, T[]> = {};

	for (const row of rows) {
		const project = row.project ?? UNKNOWN_PROJECT_LABEL;
		(projects[project] ??= []).push(row);
	}

	return projects;
}

export function createEmptyReportPayload(
	reportKey: 'daily' | 'monthly' | 'sessions',
	useInstances: boolean,
): Record<string, unknown> {
	if (useInstances) {
		return { projects: {}, totals: null };
	}

	return { [reportKey]: [], totals: null };
}

if (import.meta.vitest != null) {
	describe('groupRowsByProject', () => {
		it('groups missing projects under the unknown bucket', () => {
			const grouped = groupRowsByProject([
				{ project: '~/repo-a', totalTokens: 1 },
				{ totalTokens: 2 },
				{ project: '~/repo-a', totalTokens: 3 },
			]);

			expect(grouped).toEqual({
				'~/repo-a': [
					{ project: '~/repo-a', totalTokens: 1 },
					{ project: '~/repo-a', totalTokens: 3 },
				],
				'(unknown)': [{ totalTokens: 2 }],
			});
		});
	});

	describe('createEmptyReportPayload', () => {
		it('returns the stable projects shape for empty instances output', () => {
			expect(createEmptyReportPayload('daily', true)).toEqual({
				projects: {},
				totals: null,
			});
		});

		it('returns the legacy shape when instances output is disabled', () => {
			expect(createEmptyReportPayload('sessions', false)).toEqual({
				sessions: [],
				totals: null,
			});
		});
	});
}
