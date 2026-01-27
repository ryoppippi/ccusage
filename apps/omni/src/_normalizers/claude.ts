import type { DailyUsage, MonthlyUsage, SessionUsage } from 'ccusage/data-loader';
import type { UnifiedDailyUsage, UnifiedMonthlyUsage, UnifiedSessionUsage } from '../_types.ts';

export function normalizeClaudeDaily(data: DailyUsage): UnifiedDailyUsage {
	return {
		source: 'claude',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		totalTokens:
			data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}

export function normalizeClaudeMonthly(data: MonthlyUsage): UnifiedMonthlyUsage {
	return {
		source: 'claude',
		month: data.month,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		totalTokens:
			data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}

export function normalizeClaudeSession(data: SessionUsage): UnifiedSessionUsage {
	return {
		source: 'claude',
		sessionId: data.sessionId,
		displayName: data.projectPath,
		firstTimestamp: data.lastActivity,
		lastTimestamp: data.lastActivity,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		totalTokens:
			data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}

if (import.meta.vitest != null) {
	describe('normalizeClaudeDaily', () => {
		it('preserves cache-inclusive totalTokens', () => {
			const data = {
				date: '2025-01-01',
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 1.23,
				modelsUsed: ['claude-sonnet-4-20250514'],
				modelBreakdowns: [],
			} as unknown as DailyUsage;

			const normalized = normalizeClaudeDaily(data);

			expect(normalized.totalTokens).toBe(165);
		});
	});
}
