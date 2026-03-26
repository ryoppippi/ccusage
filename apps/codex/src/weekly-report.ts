import type {
	ModelUsage,
	PricingSource,
	TokenUsageEvent,
	WeeklyReportRow,
	WeeklyUsageSummary,
} from './_types.ts';
import { formatDisplayDate, isWithinRange, toDateKey, toWeekKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type WeeklyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

function createSummary(week: string, initialTimestamp: string): WeeklyUsageSummary {
	return {
		week,
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

export async function buildWeeklyReport(
	events: TokenUsageEvent[],
	options: WeeklyReportOptions,
): Promise<WeeklyReportRow[]> {
	const timezone = options.timezone;
	const locale = options.locale;
	const since = options.since;
	const until = options.until;
	const pricingSource = options.pricingSource;

	const summaries = new Map<string, WeeklyUsageSummary>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}

		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const weekKey = toWeekKey(event.timestamp, timezone);
		const summary = summaries.get(weekKey) ?? createSummary(weekKey, event.timestamp);
		if (!summaries.has(weekKey)) {
			summaries.set(weekKey, summary);
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

	const rows: WeeklyReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		a.week.localeCompare(b.week),
	);

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
			week: formatDisplayDate(summary.week, locale, timezone),
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
	describe('buildWeeklyReport', () => {
		it('aggregates events by week and calculates costs', async () => {
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
				async getPricing(model: string) {
					const value = pricing.get(model);
					if (value == null) {
						throw new Error(`Missing pricing for ${model}`);
					}
					return value;
				},
			};
			const report = await buildWeeklyReport(
				[
					{
						sessionId: 'session-1',
						timestamp: '2025-09-14T03:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 1_000,
						cachedInputTokens: 200,
						outputTokens: 500,
						reasoningOutputTokens: 0,
						totalTokens: 1_500,
					},
					{
						sessionId: 'session-1',
						timestamp: '2025-09-19T05:00:00.000Z',
						model: 'gpt-5-mini',
						inputTokens: 400,
						cachedInputTokens: 100,
						outputTokens: 200,
						reasoningOutputTokens: 50,
						totalTokens: 750,
					},
				],
				{
					pricingSource: stubPricingSource,
					since: '2025-09-14',
					until: '2025-09-20',
				},
			);

			expect(report).toHaveLength(1);
			const week = report[0]!;
			expect(week.inputTokens).toBe(1_400);
			expect(week.cachedInputTokens).toBe(300);
			expect(week.outputTokens).toBe(700);
			expect(week.reasoningOutputTokens).toBe(50);
			const expectedCost =
				(800 / 1_000_000) * 1.25 +
				(200 / 1_000_000) * 0.125 +
				(500 / 1_000_000) * 10 +
				(300 / 1_000_000) * 0.6 +
				(100 / 1_000_000) * 0.06 +
				(200 / 1_000_000) * 2;
			expect(week.costUSD).toBeCloseTo(expectedCost, 10);
		});
	});
}
