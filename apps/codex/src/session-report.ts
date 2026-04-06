import type {
	ModelPricing,
	ModelUsage,
	PricingSource,
	SessionReportRow,
	SessionUsageSummary,
	TokenUsageEvent,
} from './_types.ts';
import { isWithinRange, toDateKey } from './date-utils.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

export type SessionReportOptions = {
	timezone?: string;
	locale?: string;
	since?: string;
	until?: string;
	byAccount?: boolean;
	pricingSource: PricingSource;
};

function createSummary(
	sessionId: string,
	initialTimestamp: string,
	account?: string,
): SessionUsageSummary {
	return {
		sessionId,
		account,
		firstTimestamp: initialTimestamp,
		lastTimestamp: initialTimestamp,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		costUSD: 0,
		models: new Map(),
	};
}

export async function buildSessionReport(
	events: TokenUsageEvent[],
	options: SessionReportOptions,
): Promise<SessionReportRow[]> {
	const timezone = options.timezone;
	const since = options.since;
	const until = options.until;
	const pricingSource = options.pricingSource;
	const byAccount = options.byAccount === true;

	const summaries = new Map<string, SessionUsageSummary>();

	for (const event of events) {
		const rawSessionId = event.sessionId;
		if (rawSessionId == null) {
			continue;
		}
		const sessionId = rawSessionId.trim();
		if (sessionId === '') {
			continue;
		}

		const rawModelName = event.model;
		if (rawModelName == null) {
			continue;
		}
		const modelName = rawModelName.trim();
		if (modelName === '') {
			continue;
		}

		const dateKey = toDateKey(event.timestamp, timezone);
		if (!isWithinRange(dateKey, since, until)) {
			continue;
		}

		const accountCandidate = event.account?.trim();
		const account =
			accountCandidate == null || accountCandidate === '' ? 'default' : accountCandidate;
		const summaryKey = `${account}\x00${sessionId}`;
		const summary =
			summaries.get(summaryKey) ??
			createSummary(sessionId, event.timestamp, byAccount ? account : undefined);
		if (!summaries.has(summaryKey)) {
			summaries.set(summaryKey, summary);
		}

		addUsage(summary, event);
		if (event.timestamp > summary.lastTimestamp) {
			summary.lastTimestamp = event.timestamp;
		}

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

	if (summaries.size === 0) {
		return [];
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

	const sortedSummaries = Array.from(summaries.values()).sort((a, b) => {
		const timestampCompare = a.lastTimestamp.localeCompare(b.lastTimestamp);
		if (timestampCompare !== 0) {
			return timestampCompare;
		}
		const accountCompare = (a.account ?? '').localeCompare(b.account ?? '');
		if (accountCompare !== 0) {
			return accountCompare;
		}
		return a.sessionId.localeCompare(b.sessionId);
	});

	const rows: SessionReportRow[] = [];
	for (const summary of sortedSummaries) {
		let cost = 0;
		for (const [modelName, usage] of summary.models) {
			const pricing = modelPricing.get(modelName);
			if (pricing == null) {
				continue;
			}
			cost += calculateCostUSD(usage, pricing);
		}
		summary.costUSD = cost;

		const rowModels: Record<string, ModelUsage> = {};
		for (const [modelName, usage] of summary.models) {
			rowModels[modelName] = { ...usage };
		}

		const separatorIndex = summary.sessionId.lastIndexOf('/');
		const directory = separatorIndex >= 0 ? summary.sessionId.slice(0, separatorIndex) : '';
		const sessionFile =
			separatorIndex >= 0 ? summary.sessionId.slice(separatorIndex + 1) : summary.sessionId;

		rows.push({
			sessionId: summary.sessionId,
			account: summary.account,
			lastActivity: summary.lastTimestamp,
			sessionFile,
			directory,
			inputTokens: summary.inputTokens,
			cachedInputTokens: summary.cachedInputTokens,
			outputTokens: summary.outputTokens,
			reasoningOutputTokens: summary.reasoningOutputTokens,
			totalTokens: summary.totalTokens,
			costUSD: cost,
			models: rowModels,
		});
	}

	return rows;
}

if (import.meta.vitest != null) {
	describe('buildSessionReport', () => {
		it('groups events by session and calculates costs', async () => {
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

			const report = await buildSessionReport(
				[
					{
						sessionId: 'session-a',
						account: 'work',
						timestamp: '2025-09-12T01:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 1_000,
						cachedInputTokens: 100,
						outputTokens: 500,
						reasoningOutputTokens: 0,
						totalTokens: 1_500,
					},
					{
						sessionId: 'session-a',
						account: 'work',
						timestamp: '2025-09-12T02:00:00.000Z',
						model: 'gpt-5-mini',
						inputTokens: 400,
						cachedInputTokens: 100,
						outputTokens: 200,
						reasoningOutputTokens: 30,
						totalTokens: 630,
					},
					{
						sessionId: 'session-b',
						account: 'personal',
						timestamp: '2025-09-11T23:30:00.000Z',
						model: 'gpt-5',
						inputTokens: 800,
						cachedInputTokens: 0,
						outputTokens: 300,
						reasoningOutputTokens: 0,
						totalTokens: 1_100,
					},
				],
				{
					pricingSource: stubPricingSource,
				},
			);

			expect(report).toHaveLength(2);
			const first = report[0]!;
			expect(first.sessionId).toBe('session-b');
			expect(first.sessionFile).toBe('session-b');
			expect(first.directory).toBe('');
			expect(first.totalTokens).toBe(1_100);

			const second = report[1]!;
			expect(second.sessionId).toBe('session-a');
			expect(second.sessionFile).toBe('session-a');
			expect(second.directory).toBe('');
			expect(second.totalTokens).toBe(2_130);
			expect(second.models['gpt-5']?.totalTokens).toBe(1_500);
			const expectedCost =
				(900 / 1_000_000) * 1.25 +
				(100 / 1_000_000) * 0.125 +
				(500 / 1_000_000) * 10 +
				(300 / 1_000_000) * 0.6 +
				(100 / 1_000_000) * 0.06 +
				(200 / 1_000_000) * 2;
			expect(second.costUSD).toBeCloseTo(expectedCost, 10);
		});

		it('keeps same session id separate across accounts', async () => {
			const stubPricingSource: PricingSource = {
				async getPricing(): Promise<ModelPricing> {
					return {
						inputCostPerMToken: 1,
						cachedInputCostPerMToken: 0.1,
						outputCostPerMToken: 10,
					};
				},
			};

			const report = await buildSessionReport(
				[
					{
						account: 'work',
						sessionId: 'shared-session',
						timestamp: '2025-09-11T10:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 100,
						cachedInputTokens: 0,
						outputTokens: 20,
						reasoningOutputTokens: 0,
						totalTokens: 120,
					},
					{
						account: 'personal',
						sessionId: 'shared-session',
						timestamp: '2025-09-11T11:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 200,
						cachedInputTokens: 0,
						outputTokens: 30,
						reasoningOutputTokens: 0,
						totalTokens: 230,
					},
				],
				{
					pricingSource: stubPricingSource,
					byAccount: true,
				},
			);

			expect(report).toHaveLength(2);
			expect(report.map((row) => row.account)).toEqual(['work', 'personal']);
			expect(report.map((row) => row.sessionId)).toEqual(['shared-session', 'shared-session']);
		});
	});
}
