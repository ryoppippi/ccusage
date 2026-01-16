import type { DailyReportRow, MonthlyReportRow, SessionReportRow } from '@ccusage/codex/types';
import type { UnifiedDailyUsage, UnifiedMonthlyUsage, UnifiedSessionUsage } from '../_types.ts';

export function normalizeCodexDaily(data: DailyReportRow): UnifiedDailyUsage {
	return {
		source: 'codex',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cachedInputTokens,
		cacheCreationTokens: 0,
		totalTokens: data.totalTokens,
		costUSD: data.costUSD,
		models: Object.keys(data.models),
	};
}

export function normalizeCodexMonthly(data: MonthlyReportRow): UnifiedMonthlyUsage {
	return {
		source: 'codex',
		month: data.month,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cachedInputTokens,
		cacheCreationTokens: 0,
		totalTokens: data.totalTokens,
		costUSD: data.costUSD,
		models: Object.keys(data.models),
	};
}

export function normalizeCodexSession(data: SessionReportRow): UnifiedSessionUsage {
	const displayName = data.sessionFile.trim() === '' ? data.sessionId : data.sessionFile;
	return {
		source: 'codex',
		sessionId: data.sessionId,
		displayName,
		firstTimestamp: data.lastActivity,
		lastTimestamp: data.lastActivity,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cachedInputTokens,
		cacheCreationTokens: 0,
		totalTokens: data.totalTokens,
		costUSD: data.costUSD,
		models: Object.keys(data.models),
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
	});
}
