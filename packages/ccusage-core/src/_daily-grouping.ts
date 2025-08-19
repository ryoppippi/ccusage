import type { DailyProjectOutput } from './_json-output-types.ts';
import type { loadDailyUsageData } from './data-loader.ts';
import { createDailyDate, createModelName } from './_types.ts';
import { getTotalTokens } from './calculate-cost.ts';

/**
 * Type for daily data returned from loadDailyUsageData
 */
type DailyData = Awaited<ReturnType<typeof loadDailyUsageData>>;

/**
 * Group daily usage data by project for JSON output
 */
export function groupByProject(dailyData: DailyData): Record<string, DailyProjectOutput[]> {
	const projects: Record<string, DailyProjectOutput[]> = {};

	for (const data of dailyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push({
			date: data.date,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			cacheCreationTokens: data.cacheCreationTokens,
			cacheReadTokens: data.cacheReadTokens,
			totalTokens: getTotalTokens(data),
			totalCost: data.totalCost,
			modelsUsed: data.modelsUsed,
			modelBreakdowns: data.modelBreakdowns,
		});
	}

	return projects;
}

/**
 * Group daily usage data by project for table display
 */
export function groupDataByProject(dailyData: DailyData): Record<string, DailyData> {
	const projects: Record<string, DailyData> = {};

	for (const data of dailyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push(data);
	}

	return projects;
}

if (import.meta.vitest != null) {
	describe('groupByProject', () => {
		it('groups daily data by project for JSON output', () => {
			const mockData = [
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-a',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 100,
					cacheReadTokens: 200,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-b',
					inputTokens: 2000,
					outputTokens: 1000,
					cacheCreationTokens: 200,
					cacheReadTokens: 300,
					totalCost: 0.02,
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			const result = groupByProject(mockData);

			expect(Object.keys(result)).toHaveLength(2);
			expect(result['project-a']).toHaveLength(1);
			expect(result['project-b']).toHaveLength(1);
			expect(result['project-a']![0]!.totalTokens).toBe(1800);
			expect(result['project-b']![0]!.totalTokens).toBe(3500);
		});

		it('handles unknown project names', () => {
			const mockData = [
				{
					date: createDailyDate('2024-01-01'),
					project: undefined,
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
			];

			const result = groupByProject(mockData);

			expect(Object.keys(result)).toHaveLength(1);
			expect(result.unknown).toHaveLength(1);
		});
	});

	describe('groupDataByProject', () => {
		it('groups daily data by project for table display', () => {
			const mockData = [
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-a',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 100,
					cacheReadTokens: 200,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-02'),
					project: 'project-a',
					inputTokens: 800,
					outputTokens: 400,
					cacheCreationTokens: 50,
					cacheReadTokens: 150,
					totalCost: 0.008,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
			];

			const result = groupDataByProject(mockData);

			expect(Object.keys(result)).toHaveLength(1);
			expect(result['project-a']).toHaveLength(2);
			expect(result['project-a']).toEqual(mockData);
		});
	});
}
