import type { DailyReportRow, DailyUsageSummary, ModelUsage, PricingSource, TokenUsageEvent } from './_types.ts';
import { modelsMapToRecord } from './command-utils.ts';
import { formatDisplayDate, isWithinRange, toDateKey } from './date-utils.ts';
import { calculateCostUSD } from './pricing.ts';
import { addUsage, createEmptyUsage } from './token-utils.ts';

export type DailyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource?: PricingSource;
};

function createSummary(date: string, initialTimestamp: number): DailyUsageSummary {
	return {
		date,
		firstTimestamp: initialTimestamp,
		...createEmptyUsage(),
		costUSD: 0,
		models: new Map(),
	};
}

function createModelUsage(): ModelUsage {
	return {
		...createEmptyUsage(),
		cost: 0,
	};
}

export async function buildDailyReport(
	events: TokenUsageEvent[],
	options: DailyReportOptions,
): Promise<DailyReportRow[]> {
	const { timezone, locale, since, until, pricingSource } = options;

	const summaries = new Map<string, DailyUsageSummary>();

	for (const event of events) {
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const summary = summaries.get(dateKey) ?? createSummary(dateKey, event.timestamp);
		if (!summaries.has(dateKey)) {
			summaries.set(dateKey, summary);
		}

		addUsage(summary, event);
		summary.costUSD += event.cost;

		const modelName = event.modelId;
		const modelUsage = summary.models.get(modelName) ?? createModelUsage();
		if (!summary.models.has(modelName)) {
			summary.models.set(modelName, modelUsage);
		}
		addUsage(modelUsage, event);
		modelUsage.cost += event.cost;
	}

	const rows: DailyReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) => a.date.localeCompare(b.date));

	for (const summary of sortedSummaries) {
		let totalCost = summary.costUSD;

		if (pricingSource != null) {
			for (const [modelName, modelUsage] of summary.models) {
				if (modelUsage.cost === 0 && modelUsage.totalTokens > 0) {
					const pricing = await pricingSource.getPricing(modelName);
					if (pricing != null) {
						const calculatedCost = calculateCostUSD(modelUsage, pricing);
						modelUsage.cost = calculatedCost;
						totalCost += calculatedCost;
					}
				}
			}
		}

		rows.push({
			date: formatDisplayDate(summary.date, locale, timezone),
			inputTokens: summary.inputTokens,
			outputTokens: summary.outputTokens,
			reasoningTokens: summary.reasoningTokens,
			cacheReadTokens: summary.cacheReadTokens,
			cacheWriteTokens: summary.cacheWriteTokens,
			totalTokens: summary.totalTokens,
			costUSD: totalCost,
			models: modelsMapToRecord(summary.models),
		});
	}

	return rows;
}

if (import.meta.vitest != null) {
	describe('buildDailyReport', () => {
		it('aggregates events by day', async () => {
			const jan1Midnight = Date.UTC(2025, 0, 1, 0, 0, 0);
			const jan1Noon = Date.UTC(2025, 0, 1, 12, 0, 0);

			const events: TokenUsageEvent[] = [
				{
					timestamp: jan1Midnight,
					sessionId: 'session-1',
					projectId: 'project-1',
					modelId: 'claude-sonnet-4-20250514',
					providerId: 'anthropic',
					inputTokens: 1000,
					outputTokens: 500,
					reasoningTokens: 0,
					cacheReadTokens: 200,
					cacheWriteTokens: 100,
					totalTokens: 1500,
					cost: 0.05,
				},
				{
					timestamp: jan1Noon,
					sessionId: 'session-1',
					projectId: 'project-1',
					modelId: 'claude-sonnet-4-20250514',
					providerId: 'anthropic',
					inputTokens: 500,
					outputTokens: 200,
					reasoningTokens: 50,
					cacheReadTokens: 100,
					cacheWriteTokens: 50,
					totalTokens: 750,
					cost: 0.02,
				},
			];

			const rows = await buildDailyReport(events, { timezone: 'UTC' });

			expect(rows).toHaveLength(1);
			const row = rows[0]!;
			expect(row.inputTokens).toBe(1500);
			expect(row.outputTokens).toBe(700);
			expect(row.reasoningTokens).toBe(50);
			expect(row.cacheReadTokens).toBe(300);
			expect(row.cacheWriteTokens).toBe(150);
			expect(row.totalTokens).toBe(2250);
			expect(row.costUSD).toBe(0.07);
		});

		it('filters by date range', async () => {
			const events: TokenUsageEvent[] = [
				{
					timestamp: Date.parse('2025-01-01T12:00:00Z'),
					sessionId: 'session-1',
					projectId: 'project-1',
					modelId: 'claude-sonnet-4-20250514',
					providerId: 'anthropic',
					inputTokens: 1000,
					outputTokens: 500,
					reasoningTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 1500,
					cost: 0.05,
				},
				{
					timestamp: Date.parse('2025-01-02T12:00:00Z'),
					sessionId: 'session-1',
					projectId: 'project-1',
					modelId: 'claude-sonnet-4-20250514',
					providerId: 'anthropic',
					inputTokens: 500,
					outputTokens: 200,
					reasoningTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 700,
					cost: 0.02,
				},
			];

			const rows = await buildDailyReport(events, {
				since: '2025-01-02',
				until: '2025-01-02',
				timezone: 'UTC',
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]!.costUSD).toBe(0.02);
		});

		it('calculates cost from pricing when pre-calculated cost is 0', async () => {
			const events: TokenUsageEvent[] = [
				{
					timestamp: Date.UTC(2025, 0, 1, 12, 0, 0),
					sessionId: 'session-1',
					projectId: 'project-1',
					modelId: 'gemini-3-flash',
					providerId: 'google',
					inputTokens: 1_000_000,
					outputTokens: 500_000,
					reasoningTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 1_500_000,
					cost: 0,
				},
			];

			const mockPricingSource: PricingSource = {
				async getPricing() {
					return {
						inputCostPerMToken: 0.1,
						outputCostPerMToken: 0.4,
						cacheReadCostPerMToken: 0.01,
						cacheWriteCostPerMToken: 0.1,
					};
				},
			};

			const rows = await buildDailyReport(events, {
				timezone: 'UTC',
				pricingSource: mockPricingSource,
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]!.costUSD).toBeCloseTo(0.1 + 0.2);
		});
	});
}
