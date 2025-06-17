import type { DailyUsage, SessionUsage } from './data-loader';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from './calculate-cost.ts';

describe('token aggregation utilities', () => {
	it('calculateTotals should aggregate daily usage data', () => {
		const dailyData: DailyUsage[] = [
			{
				date: '2024-01-01',
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
				totalCost: 0.01,
				modelsUsed: ['claude-sonnet-4-20250514'],
				modelBreakdowns: [],
			},
			{
				date: '2024-01-02',
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 50,
				cacheReadTokens: 20,
				totalCost: 0.02,
				modelsUsed: ['claude-opus-4-20250514'],
				modelBreakdowns: [],
			},
		];

		const totals = calculateTotals(dailyData);
		expect(totals.inputTokens).toBe(300);
		expect(totals.outputTokens).toBe(150);
		expect(totals.cacheCreationTokens).toBe(75);
		expect(totals.cacheReadTokens).toBe(30);
		expect(totals.totalCost).toBeCloseTo(0.03);
	});

	it('calculateTotals should aggregate session usage data', () => {
		const sessionData: SessionUsage[] = [
			{
				sessionId: 'session-1',
				projectPath: 'project/path',
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
				totalCost: 0.01,
				lastActivity: '2024-01-01',
				versions: ['1.0.3'],
				modelsUsed: ['claude-sonnet-4-20250514'],
				modelBreakdowns: [],
			},
			{
				sessionId: 'session-2',
				projectPath: 'project/path',
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 50,
				cacheReadTokens: 20,
				totalCost: 0.02,
				lastActivity: '2024-01-02',
				versions: ['1.0.3', '1.0.4'],
				modelsUsed: ['claude-opus-4-20250514'],
				modelBreakdowns: [],
			},
		];

		const totals = calculateTotals(sessionData);
		expect(totals.inputTokens).toBe(300);
		expect(totals.outputTokens).toBe(150);
		expect(totals.cacheCreationTokens).toBe(75);
		expect(totals.cacheReadTokens).toBe(30);
		expect(totals.totalCost).toBeCloseTo(0.03);
	});

	it('getTotalTokens should sum all token types', () => {
		const tokens = {
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 25,
			cacheReadTokens: 10,
		};

		const total = getTotalTokens(tokens);
		expect(total).toBe(185);
	});

	it('getTotalTokens should handle zero values', () => {
		const tokens = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
		};

		const total = getTotalTokens(tokens);
		expect(total).toBe(0);
	});

	it('createTotalsObject should create complete totals object', () => {
		const totals = {
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 25,
			cacheReadTokens: 10,
			totalCost: 0.01,
		};

		const totalsObject = createTotalsObject(totals);
		expect(totalsObject).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 25,
			cacheReadTokens: 10,
			totalTokens: 185,
			totalCost: 0.01,
		});
	});

	it('calculateTotals should handle empty array', () => {
		const totals = calculateTotals([]);
		expect(totals).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		});
	});
});
