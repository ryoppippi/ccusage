import type {
	ModelPricing,
	ModelUsage,
	MonthlyReportRow,
	MonthlyUsageSummary,
	PricingSource,
	TokenUsageEvent,
} from './_types.ts';
import os from 'node:os';
import { formatDisplayMonth, isWithinRange, toDateKey, toMonthKey } from './date-utils.ts';
import { normalizeProjectFilter, UNKNOWN_PROJECT_LABEL } from './project-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type MonthlyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
	project?: string;
	groupByProject?: boolean;
};

function createSummary(month: string, initialTimestamp: string): MonthlyUsageSummary {
	return {
		month,
		firstTimestamp: initialTimestamp,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		costUSD: 0,
		models: new Map(),
	};
}

export async function buildMonthlyReport(
	events: TokenUsageEvent[],
	options: MonthlyReportOptions,
): Promise<MonthlyReportRow[]> {
	const timezone = options.timezone;
	const locale = options.locale;
	const since = options.since;
	const until = options.until;
	const pricingSource = options.pricingSource;

	const summaries = new Map<string, MonthlyUsageSummary>();

	const projectFilter = normalizeProjectFilter(options.project);
	const groupByProject = options.groupByProject === true;

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}

		const project = normalizeProjectFilter(event.project);

		if (projectFilter != null && project !== projectFilter) {
			continue;
		}

		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const monthKey = toMonthKey(event.timestamp, timezone);
		const groupKey = groupByProject ? `${project ?? UNKNOWN_PROJECT_LABEL}::${monthKey}` : monthKey;
		const summary = summaries.get(groupKey) ?? createSummary(monthKey, event.timestamp);
		if (!summaries.has(groupKey)) {
			summaries.set(groupKey, summary);
		}
		if (groupByProject) {
			(summary as MonthlyUsageSummary & { project?: string }).project =
				project ?? UNKNOWN_PROJECT_LABEL;
		}

		addUsage(summary, event);
		const modelUsage: ModelUsage = summary.models.get(modelName) ?? {
			...createEmptyUsage(),
			isFallback: false,
		};
		if (!summary.models.has(modelName)) {
			summary.models.set(modelName, modelUsage);
		}
		addUsage(modelUsage, event);
		if (event.isFallbackModel === true) {
			modelUsage.isFallback = true;
		}
	}

	const uniqueModels = new Set<string>();
	for (const summary of summaries.values()) {
		for (const modelName of summary.models.keys()) {
			uniqueModels.add(modelName);
		}
	}

	const modelPricing = new Map<string, Awaited<ReturnType<PricingSource['getPricing']>>>();
	for (const modelName of uniqueModels) {
		modelPricing.set(modelName, await pricingSource.getPricing(modelName));
	}

	const rows: MonthlyReportRow[] = [];

	const sortedSummaries = Array.from(summaries.values()).sort((a, b) => {
		if (groupByProject) {
			const projA = (a as MonthlyUsageSummary & { project?: string }).project ?? '';
			const projB = (b as MonthlyUsageSummary & { project?: string }).project ?? '';
			const projCmp = projA.localeCompare(projB);
			if (projCmp !== 0) {
				return projCmp;
			}
		}
		return a.month.localeCompare(b.month);
	});
	for (const summary of sortedSummaries) {
		let cost = 0;
		for (const [modelName, usage] of summary.models) {
			const pricing = modelPricing.get(modelName);
			if (pricing == null) {
				continue;
			}
			cost += calculateCostUSD(usage, pricing);
		}
		summary.costUSD = cost;

		const rowModels: Record<string, ModelUsage> = {};
		for (const [modelName, usage] of summary.models) {
			rowModels[modelName] = { ...usage };
		}

		rows.push({
			month: formatDisplayMonth(summary.month, locale, timezone),
			project: (summary as MonthlyUsageSummary & { project?: string }).project,
			inputTokens: summary.inputTokens,
			cachedInputTokens: summary.cachedInputTokens,
			outputTokens: summary.outputTokens,
			reasoningOutputTokens: summary.reasoningOutputTokens,
			totalTokens: summary.totalTokens,
			costUSD: cost,
			models: rowModels,
		});
	}

	return rows;
}

if (import.meta.vitest != null) {
	describe('buildMonthlyReport', () => {
		it('aggregates events by month and calculates costs', async () => {
			const pricing = new Map([
				[
					'gpt-5',
					{ inputCostPerMToken: 1.25, cachedInputCostPerMToken: 0.125, outputCostPerMToken: 10 },
				],
				[
					'gpt-5-mini',
					{ inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.06, outputCostPerMToken: 2 },
				],
			]);
			const stubPricingSource: PricingSource = {
				async getPricing(model: string): Promise<ModelPricing> {
					const value = pricing.get(model);
					if (value == null) {
						throw new Error(`Missing pricing for ${model}`);
					}
					return value;
				},
			};
			const report = await buildMonthlyReport(
				[
					{
						sessionId: 'session-1',
						timestamp: '2025-08-11T03:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 1_000,
						cachedInputTokens: 200,
						outputTokens: 500,
						reasoningOutputTokens: 0,
						totalTokens: 1_500,
					},
					{
						sessionId: 'session-1',
						timestamp: '2025-08-20T05:00:00.000Z',
						model: 'gpt-5-mini',
						inputTokens: 400,
						cachedInputTokens: 100,
						outputTokens: 200,
						reasoningOutputTokens: 50,
						totalTokens: 750,
					},
					{
						sessionId: 'session-2',
						timestamp: '2025-09-12T01:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 2_000,
						cachedInputTokens: 0,
						outputTokens: 800,
						reasoningOutputTokens: 0,
						totalTokens: 2_800,
					},
				],
				{
					pricingSource: stubPricingSource,
					since: '2025-08-01',
					until: '2025-09-30',
				},
			);

			expect(report).toHaveLength(2);
			const first = report[0]!;
			expect(first.inputTokens).toBe(1_400);
			expect(first.cachedInputTokens).toBe(300);
			expect(first.outputTokens).toBe(700);
			expect(first.reasoningOutputTokens).toBe(50);
			// gpt-5: 800 non-cached input @ 1.25, 200 cached @ 0.125, 500 output @ 10
			// gpt-5-mini: 300 non-cached input @ 0.6, 100 cached @ 0.06, 200 output @ 2 (reasoning already included)
			const expectedCost =
				(800 / 1_000_000) * 1.25 +
				(200 / 1_000_000) * 0.125 +
				(500 / 1_000_000) * 10 +
				(300 / 1_000_000) * 0.6 +
				(100 / 1_000_000) * 0.06 +
				(200 / 1_000_000) * 2;
			expect(first.costUSD).toBeCloseTo(expectedCost, 10);
		});

		it('normalizes the project filter before exact matching', async () => {
			const stubPricingSource: PricingSource = {
				async getPricing(): Promise<ModelPricing> {
					return {
						inputCostPerMToken: 1,
						cachedInputCostPerMToken: 0.1,
						outputCostPerMToken: 2,
					};
				},
			};

			const home = os.homedir();
			const report = await buildMonthlyReport(
				[
					{
						sessionId: 'session-1',
						timestamp: '2025-09-11T03:00:00.000Z',
						model: 'gpt-5',
						project: '~/workspace/repo',
						inputTokens: 100,
						cachedInputTokens: 0,
						outputTokens: 50,
						reasoningOutputTokens: 0,
						totalTokens: 150,
					},
				],
				{
					pricingSource: stubPricingSource,
					project: `${home}/workspace/repo`,
				},
			);

			expect(report).toHaveLength(1);
		});
	});
}
