import type { DailyReportRow, MonthlyReportRow, SessionReportRow } from '@ccusage/codex/types';
import type {
	UnifiedDailyUsage,
	UnifiedModelBreakdown,
	UnifiedMonthlyUsage,
	UnifiedSessionUsage,
} from '../_types.ts';

type ModelUsageRecord = Record<
	string,
	{
		inputTokens: number;
		cachedInputTokens: number;
		outputTokens: number;
		reasoningOutputTokens: number;
		totalTokens: number;
		isFallback?: boolean;
	}
>;

function normalizeCodexBreakdowns(
	models: ModelUsageRecord | undefined,
	totalCost: number,
): UnifiedModelBreakdown[] {
	if (models == null) {
		return [];
	}
	const entries = Object.entries(models);
	// If there's only one model, assign the full cost to it
	const singleModelCost = entries.length === 1 ? totalCost : 0;

	return entries.map(([modelName, usage]) => ({
		modelName,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheCreationTokens: 0,
		cacheReadTokens: Math.min(usage.cachedInputTokens, usage.inputTokens),
		cost: singleModelCost,
	}));
}

export function normalizeCodexDaily(data: DailyReportRow): UnifiedDailyUsage {
	const cacheReadTokens = Math.min(data.cachedInputTokens, data.inputTokens);
	const costUSD = data.costUSD ?? 0;
	return {
		source: 'codex',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens,
		cacheCreationTokens: 0,
		totalTokens: data.totalTokens ?? data.inputTokens + data.outputTokens,
		costUSD,
		models: Object.keys(data.models ?? {}),
		modelBreakdowns: normalizeCodexBreakdowns(data.models, costUSD),
	};
}

export function normalizeCodexMonthly(data: MonthlyReportRow): UnifiedMonthlyUsage {
	const cacheReadTokens = Math.min(data.cachedInputTokens, data.inputTokens);
	const costUSD = data.costUSD ?? 0;
	return {
		source: 'codex',
		month: data.month,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens,
		cacheCreationTokens: 0,
		totalTokens: data.totalTokens ?? data.inputTokens + data.outputTokens,
		costUSD,
		models: Object.keys(data.models ?? {}),
		modelBreakdowns: normalizeCodexBreakdowns(data.models, costUSD),
	};
}

export function normalizeCodexSession(data: SessionReportRow): UnifiedSessionUsage {
	const displayName = data.sessionFile.trim() === '' ? data.sessionId : data.sessionFile;
	const cacheReadTokens = Math.min(data.cachedInputTokens, data.inputTokens);
	const costUSD = data.costUSD ?? 0;
	return {
		source: 'codex',
		sessionId: data.sessionId,
		displayName,
		firstTimestamp: data.lastActivity,
		lastTimestamp: data.lastActivity,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens,
		cacheCreationTokens: 0,
		totalTokens: data.totalTokens ?? data.inputTokens + data.outputTokens,
		costUSD,
		models: Object.keys(data.models ?? {}),
		modelBreakdowns: normalizeCodexBreakdowns(data.models, costUSD),
	};
}

if (import.meta.vitest != null) {
	describe('normalizeCodexDaily', () => {
		it('keeps source totalTokens and treats cache as subset of input', () => {
			const data = {
				date: '2025-01-02',
				inputTokens: 200,
				cachedInputTokens: 50,
				outputTokens: 100,
				reasoningOutputTokens: 0,
				totalTokens: 300,
				costUSD: 2.5,
				models: {
					'gpt-5': {
						inputTokens: 200,
						cachedInputTokens: 50,
						outputTokens: 100,
						reasoningOutputTokens: 0,
						totalTokens: 300,
					},
				},
			} satisfies DailyReportRow;

			const normalized = normalizeCodexDaily(data);

			expect(normalized.cacheReadTokens).toBe(50);
			expect(normalized.totalTokens).toBe(300);
		});

		it('assigns full cost to single model breakdown', () => {
			const data = {
				date: '2025-01-02',
				inputTokens: 200,
				cachedInputTokens: 50,
				outputTokens: 100,
				reasoningOutputTokens: 0,
				totalTokens: 300,
				costUSD: 2.5,
				models: {
					'gpt-5': {
						inputTokens: 200,
						cachedInputTokens: 50,
						outputTokens: 100,
						reasoningOutputTokens: 0,
						totalTokens: 300,
					},
				},
			} satisfies DailyReportRow;

			const normalized = normalizeCodexDaily(data);

			expect(normalized.modelBreakdowns).toHaveLength(1);
			expect(normalized.modelBreakdowns[0]?.cost).toBe(2.5);
		});

		it('assigns zero cost when multiple models (cannot determine per-model cost)', () => {
			const data = {
				date: '2025-01-02',
				inputTokens: 400,
				cachedInputTokens: 100,
				outputTokens: 200,
				reasoningOutputTokens: 0,
				totalTokens: 600,
				costUSD: 5.0,
				models: {
					'gpt-5': {
						inputTokens: 200,
						cachedInputTokens: 50,
						outputTokens: 100,
						reasoningOutputTokens: 0,
						totalTokens: 300,
					},
					'gpt-5.1': {
						inputTokens: 200,
						cachedInputTokens: 50,
						outputTokens: 100,
						reasoningOutputTokens: 0,
						totalTokens: 300,
					},
				},
			} satisfies DailyReportRow;

			const normalized = normalizeCodexDaily(data);

			expect(normalized.modelBreakdowns).toHaveLength(2);
			expect(normalized.modelBreakdowns[0]?.cost).toBe(0);
			expect(normalized.modelBreakdowns[1]?.cost).toBe(0);
		});
	});
}
