import type { CodexBlockBurnRate, CodexBlockProjection, CodexSessionBlock } from './_session-blocks.ts';
import type { ModelPricing, PricingSource, TokenUsageEvent } from './_types.ts';
import { convertEventsToBlockEntries } from './_block-entry.ts';
import { calculateBurnRate, identifyCodexSessionBlocks, projectBlockUsage } from './_session-blocks.ts';
import { calculateCostUSD } from './token-utils.ts';

export type TokenLimitStatus = 'ok' | 'warning' | 'exceeds';

export type ModelUsageSummary = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	isFallback?: boolean;
};

export type CodexBlockSummary = {
	block: CodexSessionBlock;
	burnRate: CodexBlockBurnRate | null;
	projection: CodexBlockProjection | null;
	models: Record<string, ModelUsageSummary>;
	tokenLimitStatus: TokenLimitStatus | null;
	usagePercent: number | null;
};

export type CodexBlocksReport = {
	blocks: CodexBlockSummary[];
	totals: {
		tokenCounts: CodexSessionBlock['tokenCounts'];
		costUSD: number;
	};
};

export type BuildReportOptions = {
	blocks: CodexSessionBlock[];
	pricingSource: PricingSource;
	tokenLimit?: number;
};

export async function buildCodexBlocksReport(options: BuildReportOptions): Promise<CodexBlocksReport> {
	const { blocks, pricingSource, tokenLimit } = options;
	const uniqueModels = new Set<string>();
	for (const block of blocks) {
		for (const entry of block.entries) {
			uniqueModels.add(entry.model);
		}
	}

	const pricingCache = new Map<string, ModelPricing>();
	for (const model of uniqueModels) {
		pricingCache.set(model, await pricingSource.getPricing(model));
	}

	const summaries: CodexBlockSummary[] = [];
	const totals = {
		tokenCounts: {
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens: 0,
		},
		costUSD: 0,
	};

	for (const block of blocks) {
		const modelUsageMap = new Map<string, ModelUsageSummary>();
		for (const entry of block.entries) {
			const summary = modelUsageMap.get(entry.model) ?? {
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
				costUSD: 0,
				isFallback: false,
			};
			summary.inputTokens += entry.usage.inputTokens;
			summary.cachedInputTokens += entry.usage.cachedInputTokens;
			summary.outputTokens += entry.usage.outputTokens;
			summary.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
			summary.totalTokens += entry.usage.totalTokens;
			if (entry.isFallbackModel === true) {
				summary.isFallback = true;
			}
			modelUsageMap.set(entry.model, summary);
		}

		let blockCost = 0;
		const models: Record<string, ModelUsageSummary> = {};
		for (const [model, usage] of modelUsageMap) {
			const pricing = pricingCache.get(model);
			if (pricing == null) {
				continue;
			}
			const cost = calculateCostUSD(usage, pricing);
			usage.costUSD = cost;
			blockCost += cost;
			models[model] = { ...usage };
		}

		block.costUSD = blockCost;
		totals.tokenCounts.inputTokens += block.tokenCounts.inputTokens;
		totals.tokenCounts.outputTokens += block.tokenCounts.outputTokens;
		totals.tokenCounts.cachedInputTokens += block.tokenCounts.cachedInputTokens;
		totals.tokenCounts.reasoningOutputTokens += block.tokenCounts.reasoningOutputTokens;
		totals.tokenCounts.totalTokens += block.tokenCounts.totalTokens;
		totals.costUSD += blockCost;

		const burnRate = calculateBurnRate(block);
		const projection = projectBlockUsage(block);
		const usagePercent = tokenLimit != null && tokenLimit > 0
			? block.tokenCounts.totalTokens / tokenLimit
			: null;

		let tokenLimitStatus: TokenLimitStatus | null = null;
		if (tokenLimit != null && tokenLimit > 0) {
			const projectedTokens = projection?.totalTokens ?? block.tokenCounts.totalTokens;
			if (projectedTokens >= tokenLimit) {
				tokenLimitStatus = 'exceeds';
			}
			else if (projectedTokens >= tokenLimit * 0.8) {
				tokenLimitStatus = 'warning';
			}
			else {
				tokenLimitStatus = 'ok';
			}
		}

		summaries.push({
			block,
			burnRate,
			projection,
			models,
			tokenLimitStatus,
			usagePercent,
		});
	}

	return {
		blocks: summaries,
		totals,
	};
}

if (import.meta.vitest != null) {
	describe('buildCodexBlocksReport', () => {
		it('calculates costs via LiteLLM pricing and assigns token limit status', async () => {
			const events: TokenUsageEvent[] = [
				{
					sessionId: 'session-1',
					timestamp: '2025-10-05T00:00:00.000Z',
					model: 'gpt-5',
					inputTokens: 400,
					cachedInputTokens: 100,
					outputTokens: 200,
					reasoningOutputTokens: 50,
					totalTokens: 600,
				},
				{
					sessionId: 'session-1',
					timestamp: '2025-10-05T01:00:00.000Z',
					model: 'gpt-5-mini',
					inputTokens: 300,
					cachedInputTokens: 0,
					outputTokens: 150,
					reasoningOutputTokens: 0,
					totalTokens: 450,
				},
			];

			const entries = convertEventsToBlockEntries(events);
			const blocks = identifyCodexSessionBlocks(entries);

			const pricing = new Map([
				['gpt-5', { inputCostPerMToken: 1.25, cachedInputCostPerMToken: 0.125, outputCostPerMToken: 10 }],
				['gpt-5-mini', { inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.06, outputCostPerMToken: 2 }],
			]);

			const stubPricingSource: PricingSource = {
				async getPricing(model: string) {
					const value = pricing.get(model);
					if (value == null) {
						throw new Error(`missing pricing for ${model}`);
					}
					return value;
				},
			};

			blocks[0]!.isActive = false;
			const report = await buildCodexBlocksReport({
				blocks,
				pricingSource: stubPricingSource,
				tokenLimit: 1_200,
			});

			expect(report.blocks).toHaveLength(1);
			const summary = report.blocks[0]!;
			expect(summary.block.costUSD).toBeGreaterThan(0);
			expect(summary.models['gpt-5']?.costUSD).toBeGreaterThan(0);
			expect(summary.tokenLimitStatus).toBe('warning');
			expect(summary.usagePercent).toBeGreaterThan(0);
			const expectedGpt5Cost = calculateCostUSD(
				{
					inputTokens: 400,
					cachedInputTokens: 100,
					outputTokens: 200,
					reasoningOutputTokens: 50,
					totalTokens: 600,
				},
				pricing.get('gpt-5')!,
			);
			expect(summary.models['gpt-5']?.costUSD).toBeCloseTo(expectedGpt5Cost, 10);
		});

		it('marks token limit status as exceeds when projected usage is over the limit', async () => {
			const events: TokenUsageEvent[] = [
				{
					sessionId: 'session-1',
					timestamp: '2025-10-05T00:00:00.000Z',
					model: 'gpt-5',
					inputTokens: 2_000,
					cachedInputTokens: 0,
					outputTokens: 1_000,
					reasoningOutputTokens: 0,
					totalTokens: 3_000,
				},
			];
			const entries = convertEventsToBlockEntries(events);
			const blocks = identifyCodexSessionBlocks(entries);
			const stubPricingSource: PricingSource = {
				async getPricing() {
					return { inputCostPerMToken: 1, cachedInputCostPerMToken: 0.1, outputCostPerMToken: 1 };
				},
			};
			const report = await buildCodexBlocksReport({
				blocks,
				pricingSource: stubPricingSource,
				tokenLimit: 1_000,
			});
			expect(report.blocks[0]?.tokenLimitStatus).toBe('exceeds');
		});
	});
}
