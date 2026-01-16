import type { DailyReportRow } from '@ccusage/opencode/daily-report';
import type { MonthlyReportRow } from '@ccusage/opencode/monthly-report';
import type { SessionReportRow } from '@ccusage/opencode/session-report';
import type { UnifiedDailyUsage, UnifiedMonthlyUsage, UnifiedSessionUsage } from '../_types.ts';

export function normalizeOpenCodeDaily(data: DailyReportRow): UnifiedDailyUsage {
	return {
		source: 'opencode',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		totalTokens: data.totalTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}

export function normalizeOpenCodeMonthly(data: MonthlyReportRow): UnifiedMonthlyUsage {
	return {
		source: 'opencode',
		month: data.month,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		totalTokens: data.totalTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}

export function normalizeOpenCodeSession(data: SessionReportRow): UnifiedSessionUsage {
	return {
		source: 'opencode',
		sessionId: data.sessionID,
		displayName: data.sessionTitle,
		firstTimestamp: data.lastActivity,
		lastTimestamp: data.lastActivity,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		totalTokens: data.totalTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}

if (import.meta.vitest != null) {
	describe('normalizeOpenCodeDaily', () => {
		it('preserves additive totalTokens', () => {
			const data = {
				date: '2025-01-03',
				inputTokens: 10,
				outputTokens: 20,
				cacheCreationTokens: 5,
				cacheReadTokens: 2,
				totalTokens: 37,
				totalCost: 0.25,
				modelsUsed: ['claude-opus-4-20250514'],
			} satisfies DailyReportRow;

			const normalized = normalizeOpenCodeDaily(data);

			expect(normalized.totalTokens).toBe(37);
		});
	});
}
