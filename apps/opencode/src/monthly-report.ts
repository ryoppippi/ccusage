import type { ModelUsage, MonthlyReportRow, MonthlyUsageSummary, PricingSource, TokenUsageEvent } from './_types.ts';
import { modelsMapToRecord } from './command-utils.ts';
import { formatDisplayMonth, isWithinRange, toDateKey, toMonthKey } from './date-utils.ts';
import { calculateCostUSD } from './pricing.ts';
import { addUsage, createEmptyUsage } from './token-utils.ts';

export type MonthlyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource?: PricingSource;
};

function createSummary(month: string, initialTimestamp: number): MonthlyUsageSummary {
	return {
		month,
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

export async function buildMonthlyReport(
	events: TokenUsageEvent[],
	options: MonthlyReportOptions,
): Promise<MonthlyReportRow[]> {
	const { timezone, locale, since, until, pricingSource } = options;

	const summaries = new Map<string, MonthlyUsageSummary>();

	for (const event of events) {
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const monthKey = toMonthKey(event.timestamp, timezone);
		const summary = summaries.get(monthKey) ?? createSummary(monthKey, event.timestamp);
		if (!summaries.has(monthKey)) {
			summaries.set(monthKey, summary);
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

	const rows: MonthlyReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) => a.month.localeCompare(b.month));

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
			month: formatDisplayMonth(summary.month, locale, timezone),
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
	describe('buildMonthlyReport', () => {
		it('aggregates events by month', async () => {
			const aug15 = Date.UTC(2025, 7, 15, 12, 0, 0);
			const aug20 = Date.UTC(2025, 7, 20, 12, 0, 0);
			const sep10 = Date.UTC(2025, 8, 10, 12, 0, 0);

			const events: TokenUsageEvent[] = [
				{
					timestamp: aug15,
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
					timestamp: aug20,
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
				{
					timestamp: sep10,
					sessionId: 'session-2',
					projectId: 'project-1',
					modelId: 'claude-opus-4-20250514',
					providerId: 'anthropic',
					inputTokens: 2000,
					outputTokens: 800,
					reasoningTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 2800,
					cost: 0.15,
				},
			];

			const rows = await buildMonthlyReport(events, { timezone: 'UTC' });

			expect(rows).toHaveLength(2);

			const augRow = rows[0]!;
			expect(augRow.inputTokens).toBe(1500);
			expect(augRow.outputTokens).toBe(700);
			expect(augRow.reasoningTokens).toBe(50);
			expect(augRow.cacheReadTokens).toBe(300);
			expect(augRow.cacheWriteTokens).toBe(150);
			expect(augRow.totalTokens).toBe(2250);
			expect(augRow.costUSD).toBe(0.07);

			const sepRow = rows[1]!;
			expect(sepRow.inputTokens).toBe(2000);
			expect(sepRow.outputTokens).toBe(800);
			expect(sepRow.totalTokens).toBe(2800);
			expect(sepRow.costUSD).toBe(0.15);
		});

		it('filters by date range', async () => {
			const events: TokenUsageEvent[] = [
				{
					timestamp: Date.parse('2025-08-15T12:00:00Z'),
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
					timestamp: Date.parse('2025-09-10T12:00:00Z'),
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

			const rows = await buildMonthlyReport(events, {
				since: '2025-09-01',
				until: '2025-09-30',
				timezone: 'UTC',
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]!.costUSD).toBe(0.02);
		});
	});
}
