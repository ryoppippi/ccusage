import type {
	DailyReportRow,
	DailyUsageSummary,
	ModelPricing,
	ModelUsage,
	PricingSource,
	TokenUsageEvent,
} from './_types.ts';
import { formatDisplayDate, isWithinRange, toDateKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type DailyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

function createSummary(date: string, initialTimestamp: string): DailyUsageSummary {
	return {
		date,
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

export async function buildDailyReport(
	events: TokenUsageEvent[],
	options: DailyReportOptions,
): Promise<DailyReportRow[]> {
	const timezone = options.timezone;
	const locale = options.locale;
	const since = options.since;
	const until = options.until;
	const pricingSource = options.pricingSource;

	const summaries = new Map<string, DailyUsageSummary>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}

		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const summary = summaries.get(dateKey) ?? createSummary(dateKey, event.timestamp);
		if (!summaries.has(dateKey)) {
			summaries.set(dateKey, summary);
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

	const rows: DailyReportRow[] = [];

	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		a.date.localeCompare(b.date),
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
			const pricing = modelPricing.get(modelName);
			rowModels[modelName] = {
				...usage,
				pricingResolution: pricing?.pricingResolution,
				pricingModel: pricing?.pricingModel,
			};
		}

		rows.push({
			date: formatDisplayDate(summary.date, locale, timezone),
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
	describe('buildDailyReport', () => {
		it('aggregates events by day and calculates costs', async () => {
			const pricing = new Map([
				[
					'gpt-5',
					{
						inputCostPerMToken: 1.25,
						cachedInputCostPerMToken: 0.125,
						outputCostPerMToken: 10,
						pricingResolution: 'direct' as const,
						pricingModel: 'gpt-5',
					},
				],
				[
					'gpt-5-mini',
					{
						inputCostPerMToken: 0.6,
						cachedInputCostPerMToken: 0.06,
						outputCostPerMToken: 2,
						pricingResolution: 'direct' as const,
						pricingModel: 'gpt-5-mini',
					},
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
			const report = await buildDailyReport(
				[
					{
						sessionId: 'session-1',
						timestamp: '2025-09-11T03:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 1_000,
						cachedInputTokens: 200,
						outputTokens: 500,
						reasoningOutputTokens: 0,
						totalTokens: 1_500,
					},
					{
						sessionId: 'session-1',
						timestamp: '2025-09-11T05:00:00.000Z',
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
					since: '2025-09-11',
					until: '2025-09-12',
				},
			);

			expect(report).toHaveLength(2);
			const first = report[0]!;
			expect(first.date).toContain('2025');
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
	});
}
