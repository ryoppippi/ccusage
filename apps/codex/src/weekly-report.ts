import type { DayOfWeek, WeekDay } from './_consts.ts';
import type { ModelPricing, PricingSource, TokenUsageEvent, WeeklyReportRow } from './_types.ts';
import { buildBucketedReport } from './bucketed-report.ts';
import { toDateKey } from './date-utils.ts';

export type WeeklyReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	startOfWeek?: WeekDay;
	until?: string;
	pricingSource: PricingSource;
};

function getDayNumber(day: WeekDay): DayOfWeek {
	const dayMap = {
		sunday: 0,
		monday: 1,
		tuesday: 2,
		wednesday: 3,
		thursday: 4,
		friday: 5,
		saturday: 6,
	} as const satisfies Record<WeekDay, DayOfWeek>;
	return dayMap[day];
}

function toWeekKey(timestamp: string, timezone: string | undefined, startDay: DayOfWeek): string {
	const dateKey = toDateKey(timestamp, timezone);
	const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	const shift = (date.getUTCDay() - startDay + 7) % 7;
	date.setUTCDate(date.getUTCDate() - shift);
	return date.toISOString().slice(0, 10);
}

export async function buildWeeklyReport(
	events: TokenUsageEvent[],
	options: WeeklyReportOptions,
): Promise<WeeklyReportRow[]> {
	const startDay = getDayNumber(options.startOfWeek ?? 'sunday');

	return buildBucketedReport({
		bucketField: 'week',
		events,
		getBucketKey: (timestamp, timezone) => toWeekKey(timestamp, timezone, startDay),
		getFilterDateKey: toDateKey,
		pricingSource: options.pricingSource,
		since: options.since,
		timezone: options.timezone,
		until: options.until,
	});
}

if (import.meta.vitest != null) {
	describe('buildWeeklyReport', () => {
		it('aggregates events by default Sunday week start date and calculates costs', async () => {
			const pricing = new Map([
				[
					'gpt-5',
					{ inputCostPerMToken: 1.25, cachedInputCostPerMToken: 0.125, outputCostPerMToken: 10 },
				],
				[
					'gpt-5-mini',
					{ inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.06, outputCostPerMToken: 2 },
				],
			]);
			const stubPricingSource: PricingSource = {
				async getPricing(model: string): Promise<ModelPricing> {
					const value = pricing.get(model);
					if (value == null) {
						throw new Error(`Missing pricing for ${model}`);
					}
					return value;
				},
			};
			const report = await buildWeeklyReport(
				[
					{
						sessionId: 'session-1',
						timestamp: '2025-09-08T12:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 1_000,
						cachedInputTokens: 200,
						outputTokens: 500,
						reasoningOutputTokens: 0,
						totalTokens: 1_500,
					},
					{
						sessionId: 'session-1',
						timestamp: '2025-09-13T23:00:00.000Z',
						model: 'gpt-5-mini',
						inputTokens: 400,
						cachedInputTokens: 100,
						outputTokens: 200,
						reasoningOutputTokens: 50,
						totalTokens: 750,
					},
					{
						sessionId: 'session-2',
						timestamp: '2025-09-15T12:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 2_000,
						cachedInputTokens: 0,
						outputTokens: 800,
						reasoningOutputTokens: 0,
						totalTokens: 2_800,
					},
				],
				{
					pricingSource: stubPricingSource,
					since: '2025-09-08',
					timezone: 'UTC',
					until: '2025-09-15',
				},
			);

			expect(report).toHaveLength(2);
			const first = report[0]!;
			expect(first.week).toBe('2025-09-07');
			expect(first.inputTokens).toBe(1_400);
			expect(first.cachedInputTokens).toBe(300);
			expect(first.outputTokens).toBe(700);
			expect(first.reasoningOutputTokens).toBe(50);
			const expectedCost =
				(800 / 1_000_000) * 1.25 +
				(200 / 1_000_000) * 0.125 +
				(500 / 1_000_000) * 10 +
				(300 / 1_000_000) * 0.6 +
				(100 / 1_000_000) * 0.06 +
				(200 / 1_000_000) * 2;
			expect(first.costUSD).toBeCloseTo(expectedCost, 10);
		});

		it('supports Monday-start weeks like Claude weekly --start-of-week monday', async () => {
			const stubPricingSource: PricingSource = {
				async getPricing(): Promise<ModelPricing> {
					return {
						inputCostPerMToken: 0,
						cachedInputCostPerMToken: 0,
						outputCostPerMToken: 0,
					};
				},
			};
			const report = await buildWeeklyReport(
				[
					{
						sessionId: 'session-1',
						timestamp: '2025-09-08T12:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 1,
						cachedInputTokens: 0,
						outputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 1,
					},
					{
						sessionId: 'session-1',
						timestamp: '2025-09-14T12:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 2,
						cachedInputTokens: 0,
						outputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 2,
					},
				],
				{
					pricingSource: stubPricingSource,
					startOfWeek: 'monday',
					timezone: 'UTC',
				},
			);

			expect(report).toHaveLength(1);
			expect(report[0]?.week).toBe('2025-09-08');
			expect(report[0]?.inputTokens).toBe(3);
		});
	});
}
