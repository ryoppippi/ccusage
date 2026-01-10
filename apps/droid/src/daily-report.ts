/**
 * @fileoverview Daily aggregation for Factory Droid token usage.
 */

import type { DailyReportRow, ModelUsage, PricingSource, TokenUsageEvent } from './_types.ts';
import { sort } from 'fast-sort';
import { formatDisplayDate, isWithinRange, toDateKey } from './date-utils.ts';
import { addUsage, createEmptyUsage } from './token-utils.ts';

type DailySummary = {
	dateKey: string;
	totalUsage: ModelUsage;
	modelsUsed: Set<string>;
	pricingModels: Map<string, ModelUsage>;
};

export type DailyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

export type DailyReportResult = {
	rows: DailyReportRow[];
	missingPricingModels: string[];
};

function formatModelDisplay(event: TokenUsageEvent): string {
	const suffix = event.modelIdSource === 'settings' ? ' [inferred]' : '';
	if (event.modelId.startsWith('custom:')) {
		const base = event.pricingModel.trim() !== '' ? event.pricingModel : event.modelId;
		return `${base} [custom]${suffix}`;
	}

	return `${event.modelId}${suffix}`;
}

function addEventUsage(target: ModelUsage, event: TokenUsageEvent): void {
	addUsage(target, {
		inputTokens: event.inputTokens,
		outputTokens: event.outputTokens,
		thinkingTokens: event.thinkingTokens,
		cacheReadTokens: event.cacheReadTokens,
		cacheCreationTokens: event.cacheCreationTokens,
	});
}

function getOrCreateModelUsage(map: Map<string, ModelUsage>, key: string): ModelUsage {
	const existing = map.get(key);
	if (existing != null) {
		return existing;
	}
	const created = createEmptyUsage();
	map.set(key, created);
	return created;
}

/**
 * Builds a daily report from raw token usage events.
 *
 * Events are grouped by day (timezone-aware), aggregated per model, and priced
 * via the provided `PricingSource`.
 */
export async function buildDailyReport(
	events: TokenUsageEvent[],
	options: DailyReportOptions,
): Promise<DailyReportResult> {
	const summaries = new Map<string, DailySummary>();
	const missingPricingModels = new Set<string>();

	for (const event of events) {
		const dateKey = toDateKey(event.timestamp, options.timezone);
		if (!isWithinRange(dateKey, options.since, options.until)) {
			continue;
		}

		const summary = summaries.get(dateKey) ?? {
			dateKey,
			totalUsage: createEmptyUsage(),
			modelsUsed: new Set<string>(),
			pricingModels: new Map<string, ModelUsage>(),
		};
		if (!summaries.has(dateKey)) {
			summaries.set(dateKey, summary);
		}

		summary.modelsUsed.add(formatModelDisplay(event));
		addEventUsage(summary.totalUsage, event);

		if (event.pricingModel.trim() !== '') {
			const usage = getOrCreateModelUsage(summary.pricingModels, event.pricingModel);
			addEventUsage(usage, event);
		}
	}

	const rows: DailyReportRow[] = [];

	for (const summary of sort(Array.from(summaries.values())).asc((s) => s.dateKey)) {
		let costUSD = 0;
		for (const [pricingModel, usage] of summary.pricingModels) {
			try {
				const priced = await options.pricingSource.calculateCost(pricingModel, usage);
				costUSD += priced.costUSD;
			} catch {
				missingPricingModels.add(pricingModel);
			}
		}

		rows.push({
			date: formatDisplayDate(summary.dateKey, options.locale, options.timezone),
			inputTokens: summary.totalUsage.inputTokens,
			outputTokens: summary.totalUsage.outputTokens,
			thinkingTokens: summary.totalUsage.thinkingTokens,
			cacheReadTokens: summary.totalUsage.cacheReadTokens,
			cacheCreationTokens: summary.totalUsage.cacheCreationTokens,
			totalTokens: summary.totalUsage.totalTokens,
			costUSD,
			modelsUsed: sort(Array.from(summary.modelsUsed)).asc((model) => model),
		});
	}

	return {
		rows,
		missingPricingModels: sort(Array.from(missingPricingModels)).asc((model) => model),
	};
}

if (import.meta.vitest != null) {
	describe('buildDailyReport', () => {
		it('aggregates events by day and tolerates missing pricing', async () => {
			const stubPricingSource: PricingSource = {
				async calculateCost(pricingModel, usage) {
					if (pricingModel !== 'gpt-5.2(high)') {
						throw new Error('missing');
					}
					return {
						costUSD: usage.inputTokens * 1e-6 + (usage.outputTokens + usage.thinkingTokens) * 2e-6,
						usedPricingModel: pricingModel,
					};
				},
			};

			const report = await buildDailyReport(
				[
					{
						timestamp: '2026-01-01T00:00:00.000Z',
						sessionId: 's1',
						projectKey: 'proj',
						modelId: 'custom:GPT-5.2-(High)-18',
						modelIdSource: 'tag',
						pricingModel: 'gpt-5.2(high)',
						inputTokens: 100,
						outputTokens: 50,
						thinkingTokens: 10,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						totalTokens: 160,
					},
					{
						timestamp: '2026-01-01T00:10:00.000Z',
						sessionId: 's1',
						projectKey: 'proj',
						modelId: 'custom:Unknown',
						modelIdSource: 'tag',
						pricingModel: 'unknown-model',
						inputTokens: 100,
						outputTokens: 50,
						thinkingTokens: 10,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						totalTokens: 160,
					},
				],
				{
					pricingSource: stubPricingSource,
					since: '2026-01-01',
					until: '2026-01-01',
				},
			);

			expect(report.rows).toHaveLength(1);
			expect(report.missingPricingModels).toEqual(['unknown-model']);
			expect(report.rows[0]?.inputTokens).toBe(200);
			expect(report.rows[0]?.modelsUsed).toEqual([
				'gpt-5.2(high) [custom]',
				'unknown-model [custom]',
			]);
			expect(report.rows[0]?.costUSD).toBeGreaterThan(0);
		});
	});
}
