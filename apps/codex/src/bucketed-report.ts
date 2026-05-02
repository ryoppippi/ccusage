import type { ModelUsage, PricingSource, TokenUsageDelta, TokenUsageEvent } from './_types.ts';
import { isWithinRange } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

type BucketSummary = {
	bucket: string;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

type BucketedReportRow<BucketField extends string> = Record<BucketField, string> &
	TokenUsageDelta & {
		costUSD: number;
		models: Record<string, ModelUsage>;
	};

export type BucketedReportOptions<BucketField extends string> = {
	bucketField: BucketField;
	events: TokenUsageEvent[];
	getBucketKey: (timestamp: string, timezone?: string) => string;
	getFilterDateKey: (timestamp: string, timezone?: string) => string;
	pricingSource: PricingSource;
	since?: string;
	timezone?: string;
	until?: string;
};

function createSummary(bucket: string): BucketSummary {
	return {
		bucket,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		models: new Map(),
	};
}

export async function buildBucketedReport<BucketField extends string>({
	bucketField,
	events,
	getBucketKey,
	getFilterDateKey,
	pricingSource,
	since,
	timezone,
	until,
}: BucketedReportOptions<BucketField>): Promise<Array<BucketedReportRow<BucketField>>> {
	const summaries = new Map<string, BucketSummary>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}

		const dateKey = getFilterDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const bucketKey = getBucketKey(event.timestamp, timezone);
		const summary = summaries.get(bucketKey) ?? createSummary(bucketKey);
		if (!summaries.has(bucketKey)) {
			summaries.set(bucketKey, summary);
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

	const rows: Array<BucketedReportRow<BucketField>> = [];
	const sortedSummaries = Array.from(summaries.values()).sort((a, b) =>
		a.bucket.localeCompare(b.bucket),
	);

	for (const summary of sortedSummaries) {
		let costUSD = 0;
		for (const [modelName, usage] of summary.models) {
			const pricing = modelPricing.get(modelName);
			if (pricing == null) {
				continue;
			}
			costUSD += calculateCostUSD(usage, pricing);
		}

		const models: Record<string, ModelUsage> = {};
		for (const [modelName, usage] of summary.models) {
			models[modelName] = { ...usage };
		}

		rows.push({
			[bucketField]: summary.bucket,
			inputTokens: summary.inputTokens,
			cachedInputTokens: summary.cachedInputTokens,
			outputTokens: summary.outputTokens,
			reasoningOutputTokens: summary.reasoningOutputTokens,
			totalTokens: summary.totalTokens,
			costUSD,
			models,
		} as BucketedReportRow<BucketField>);
	}

	return rows;
}
