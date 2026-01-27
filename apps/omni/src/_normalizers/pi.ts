import type {
	DailyUsageWithSource,
	MonthlyUsageWithSource,
	SessionUsageWithSource,
} from '@ccusage/pi/data-loader';
import type { UnifiedDailyUsage, UnifiedMonthlyUsage, UnifiedSessionUsage } from '../_types.ts';

export function normalizePiDaily(data: DailyUsageWithSource): UnifiedDailyUsage {
	return {
		source: 'pi',
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

export function normalizePiMonthly(data: MonthlyUsageWithSource): UnifiedMonthlyUsage {
	return {
		source: 'pi',
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

export function normalizePiSession(data: SessionUsageWithSource): UnifiedSessionUsage {
	return {
		source: 'pi',
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
	describe('normalizePiDaily', () => {
		it('preserves cache-inclusive totalTokens', () => {
			const data = {
				date: '2025-01-04',
				source: 'pi-agent',
				inputTokens: 40,
				outputTokens: 10,
				cacheCreationTokens: 3,
				cacheReadTokens: 2,
				totalCost: 0.5,
				modelsUsed: ['[pi] claude-opus-4-20250514'],
				modelBreakdowns: [],
			} satisfies DailyUsageWithSource;

			const normalized = normalizePiDaily(data);

			expect(normalized.totalTokens).toBe(55);
		});
	});
}
