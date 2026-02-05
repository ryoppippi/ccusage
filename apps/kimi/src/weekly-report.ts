import type {
	ModelUsage,
	PricingSource,
	TokenUsageEvent,
	WeeklyReportRow,
	WeeklyUsageSummary,
} from './_types.ts';
import { formatDisplayWeek, isWithinRange, toDateKey, toWeekKey } from './date-utils.ts';
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
			week: formatDisplayWeek(summary.week),
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
	describe('toWeekKey', () => {
		it('should get ISO week for a date in the middle of the year', () => {
			const timestamp = '2025-06-15T10:00:00Z';
			const week = toWeekKey(timestamp);
			expect(week).toBe('2025-W24');
		});

		it('should handle year boundary correctly', () => {
			// Dec 29, 2025 is a Monday (first week of 2026 in ISO)
			const timestamp = '2025-12-29T10:00:00Z';
			const week = toWeekKey(timestamp);
			expect(week).toBe('2026-W01');
		});

		it('should handle first week of year', () => {
			// Jan 5, 2025 is a Sunday (week 1 of 2025)
			const timestamp = '2025-01-05T10:00:00Z';
			const week = toWeekKey(timestamp);
			expect(week).toBe('2025-W01');
		});

		it('should handle last days of previous year belonging to week 1', () => {
			// Jan 1, 2025 is a Wednesday (week 1 of 2025)
			const timestamp = '2025-01-01T10:00:00Z';
			const week = toWeekKey(timestamp);
			expect(week).toBe('2025-W01');
		});
	});
}
