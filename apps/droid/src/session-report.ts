import type { ModelUsage, PricingSource, SessionReportRow, TokenUsageEvent } from './_types.ts';
import { sort } from 'fast-sort';
import { isWithinRange, toDateKey } from './date-utils.ts';
import { addUsage, createEmptyUsage } from './token-utils.ts';

type SessionSummary = {
	directory: string;
	sessionId: string;
	modelsUsed: Set<string>;
	totalUsage: ModelUsage;
	pricingModels: Map<string, ModelUsage>;
	lastActivity: string;
};

export type SessionReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	pricingSource: PricingSource;
};

export type SessionReportResult = {
	rows: SessionReportRow[];
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

export async function buildSessionReport(
	events: TokenUsageEvent[],
	options: SessionReportOptions,
): Promise<SessionReportResult> {
	const summaries = new Map<string, SessionSummary>();
	const missingPricingModels = new Set<string>();

	for (const event of events) {
		const dateKey = toDateKey(event.timestamp, options.timezone);
		if (!isWithinRange(dateKey, options.since, options.until)) {
			continue;
		}

		const key = `${event.projectKey}::${event.sessionId}`;
		const summary = summaries.get(key) ?? {
			directory: event.projectKey,
			sessionId: event.sessionId,
			modelsUsed: new Set<string>(),
			totalUsage: createEmptyUsage(),
			pricingModels: new Map<string, ModelUsage>(),
			lastActivity: event.timestamp,
		};
		if (!summaries.has(key)) {
			summaries.set(key, summary);
		}

		summary.modelsUsed.add(formatModelDisplay(event));
		addEventUsage(summary.totalUsage, event);
		if (event.timestamp > summary.lastActivity) {
			summary.lastActivity = event.timestamp;
		}

		if (event.pricingModel.trim() !== '') {
			const usage = getOrCreateModelUsage(summary.pricingModels, event.pricingModel);
			addEventUsage(usage, event);
		}
	}

	const rows: SessionReportRow[] = [];

	for (const summary of sort(Array.from(summaries.values())).desc((s) => s.lastActivity)) {
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
			directory: summary.directory,
			sessionId: summary.sessionId,
			modelsUsed: sort(Array.from(summary.modelsUsed)).asc((model) => model),
			inputTokens: summary.totalUsage.inputTokens,
			outputTokens: summary.totalUsage.outputTokens,
			thinkingTokens: summary.totalUsage.thinkingTokens,
			cacheReadTokens: summary.totalUsage.cacheReadTokens,
			cacheCreationTokens: summary.totalUsage.cacheCreationTokens,
			totalTokens: summary.totalUsage.totalTokens,
			costUSD,
			lastActivity: summary.lastActivity,
		});
	}

	return {
		rows,
		missingPricingModels: sort(Array.from(missingPricingModels)).asc((model) => model),
	};
}
