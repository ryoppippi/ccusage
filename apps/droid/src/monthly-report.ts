/**
 * @fileoverview Monthly aggregation for Factory Droid token usage.
 */

import type { ModelUsage, MonthlyReportRow, PricingSource, TokenUsageEvent } from './_types.ts';
import { sort } from 'fast-sort';
import { formatDisplayMonth, isWithinRange, toDateKey, toMonthKey } from './date-utils.ts';
import { addUsage, createEmptyUsage } from './token-utils.ts';

type MonthlySummary = {
	monthKey: string;
	totalUsage: ModelUsage;
	modelsUsed: Set<string>;
	pricingModels: Map<string, ModelUsage>;
};

export type MonthlyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

export type MonthlyReportResult = {
	rows: MonthlyReportRow[];
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
 * Builds a monthly report from raw token usage events.
 */
export async function buildMonthlyReport(
	events: TokenUsageEvent[],
	options: MonthlyReportOptions,
): Promise<MonthlyReportResult> {
	const summaries = new Map<string, MonthlySummary>();
	const missingPricingModels = new Set<string>();

	for (const event of events) {
		const dateKey = toDateKey(event.timestamp, options.timezone);
		if (!isWithinRange(dateKey, options.since, options.until)) {
			continue;
		}

		const monthKey = toMonthKey(event.timestamp, options.timezone);

		const summary = summaries.get(monthKey) ?? {
			monthKey,
			totalUsage: createEmptyUsage(),
			modelsUsed: new Set<string>(),
			pricingModels: new Map<string, ModelUsage>(),
		};
		if (!summaries.has(monthKey)) {
			summaries.set(monthKey, summary);
		}

		summary.modelsUsed.add(formatModelDisplay(event));
		addEventUsage(summary.totalUsage, event);

		if (event.pricingModel.trim() !== '') {
			const usage = getOrCreateModelUsage(summary.pricingModels, event.pricingModel);
			addEventUsage(usage, event);
		}
	}

	const rows: MonthlyReportRow[] = [];

	for (const summary of sort(Array.from(summaries.values())).asc((s) => s.monthKey)) {
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
			month: formatDisplayMonth(summary.monthKey, options.locale, options.timezone),
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
