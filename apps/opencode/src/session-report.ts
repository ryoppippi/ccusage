import type { ModelUsage, PricingSource, SessionReportRow, SessionUsageSummary, TokenUsageEvent } from './_types.ts';
import { modelsMapToRecord } from './command-utils.ts';
import { formatDisplayDateTime, isWithinRange, toDateKey } from './date-utils.ts';
import { calculateCostUSD } from './pricing.ts';
import { addUsage, createEmptyUsage } from './token-utils.ts';

export type SessionReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource?: PricingSource;
};

function createSummary(sessionId: string, projectId: string, initialTimestamp: number): SessionUsageSummary {
	return {
		sessionId,
		projectId,
		firstTimestamp: initialTimestamp,
		lastTimestamp: initialTimestamp,
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

export async function buildSessionReport(
	events: TokenUsageEvent[],
	options: SessionReportOptions,
): Promise<SessionReportRow[]> {
	const { timezone, locale, since, until, pricingSource } = options;

	const summaries = new Map<string, SessionUsageSummary>();

	for (const event of events) {
		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const summary = summaries.get(event.sessionId) ?? createSummary(event.sessionId, event.projectId, event.timestamp);
		if (!summaries.has(event.sessionId)) {
			summaries.set(event.sessionId, summary);
		}

		addUsage(summary, event);
		summary.costUSD += event.cost;

		if (event.timestamp > summary.lastTimestamp) {
			summary.lastTimestamp = event.timestamp;
		}

		const modelName = event.modelId;
		const modelUsage = summary.models.get(modelName) ?? createModelUsage();
		if (!summary.models.has(modelName)) {
			summary.models.set(modelName, modelUsage);
		}
		addUsage(modelUsage, event);
		modelUsage.cost += event.cost;
	}

	const rows: SessionReportRow[] = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) => a.lastTimestamp - b.lastTimestamp);

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
			sessionId: summary.sessionId,
			projectId: summary.projectId,
			lastActivity: formatDisplayDateTime(summary.lastTimestamp, locale, timezone),
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
	describe('buildSessionReport', () => {
		it('aggregates events by session', async () => {
			const t1 = Date.UTC(2025, 0, 1, 10, 0, 0);
			const t2 = Date.UTC(2025, 0, 1, 11, 0, 0);
			const t3 = Date.UTC(2025, 0, 1, 9, 0, 0);

			const events: TokenUsageEvent[] = [
				{
					timestamp: t1,
					sessionId: 'session-a',
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
					timestamp: t2,
					sessionId: 'session-a',
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
					timestamp: t3,
					sessionId: 'session-b',
					projectId: 'project-2',
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

			const rows = await buildSessionReport(events, { timezone: 'UTC' });

			expect(rows).toHaveLength(2);

			const sessionB = rows[0]!;
			expect(sessionB.sessionId).toBe('session-b');
			expect(sessionB.projectId).toBe('project-2');
			expect(sessionB.totalTokens).toBe(2800);
			expect(sessionB.costUSD).toBe(0.15);

			const sessionA = rows[1]!;
			expect(sessionA.sessionId).toBe('session-a');
			expect(sessionA.projectId).toBe('project-1');
			expect(sessionA.inputTokens).toBe(1500);
			expect(sessionA.outputTokens).toBe(700);
			expect(sessionA.reasoningTokens).toBe(50);
			expect(sessionA.cacheReadTokens).toBe(300);
			expect(sessionA.cacheWriteTokens).toBe(150);
			expect(sessionA.totalTokens).toBe(2250);
			expect(sessionA.costUSD).toBe(0.07);
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
					sessionId: 'session-2',
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

			const rows = await buildSessionReport(events, {
				since: '2025-01-02',
				until: '2025-01-02',
				timezone: 'UTC',
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]!.sessionId).toBe('session-2');
			expect(rows[0]!.costUSD).toBe(0.02);
		});
	});
}
