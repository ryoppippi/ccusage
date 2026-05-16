import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createEmptyRow, formatDateKey, isWithinRange, normalizeDateFilter } from '../shared.ts';
import { loadAmpUsageEvents } from './parser.ts';
import { detectAmpThreadFiles } from './paths.ts';
import { prefetchAmpPricing } from './pricing-macro.ts' with { type: 'macro' };
import { AMP_PROVIDER_PREFIXES, calculateAmpCost } from './pricing.ts';

export async function detectAmp(): Promise<boolean> {
	return detectAmpThreadFiles();
}

export async function loadAmpRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const events = await loadAmpUsageEvents();
	using ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({
					offline: options.offline === true,
					offlineLoader: async () => prefetchAmpPricing(),
					logger,
					providerPrefixes: AMP_PROVIDER_PREFIXES,
				})
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher;
	if (fetcher == null) {
		throw new Error('Amp pricing fetcher was not initialized');
	}
	const groups = new Map<string, { row: AgentUsageRow; models: Set<string>; credits: number }>();

	for (const event of events) {
		const date = formatDateKey(event.timestamp, options.timezone);
		if (!isWithinRange(date, since, until)) {
			continue;
		}
		const period =
			kind === 'session' ? event.threadId : kind === 'monthly' ? date.slice(0, 7) : date;
		const group = groups.get(period) ?? {
			row: createEmptyRow(period, 'amp'),
			models: new Set(),
			credits: 0,
		};
		if (!groups.has(period)) {
			groups.set(period, group);
		}
		group.row.inputTokens += event.inputTokens;
		group.row.outputTokens += event.outputTokens;
		group.row.cacheCreationTokens += event.cacheCreationInputTokens;
		group.row.cacheReadTokens += event.cacheReadInputTokens;
		group.row.totalTokens +=
			event.inputTokens +
			event.outputTokens +
			event.cacheCreationInputTokens +
			event.cacheReadInputTokens;
		group.row.totalCost += await calculateAmpCost(fetcher, event);
		group.credits += event.credits;
		group.models.add(event.model);
	}

	return Array.from(groups.values(), ({ row, models, credits }) => ({
		...row,
		modelsUsed: Array.from(models).sort(compareStrings),
		metadata: { credits },
	})).sort((a, b) => compareStrings(a.period, b.period));
}

if (import.meta.vitest != null) {
	describe('loadAmpRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates Amp thread usage into daily rows', async () => {
			await using fixture = await createFixture({
				threads: {
					'thread.json': JSON.stringify({
						id: 'thread-a',
						messages: [
							{
								role: 'assistant',
								messageId: 2,
								usage: {
									cacheCreationInputTokens: 20,
									cacheReadInputTokens: 10,
								},
							},
						],
						usageLedger: {
							events: [
								{
									timestamp: '2026-05-01T01:02:03.000Z',
									model: 'claude-sonnet-4-20250514',
									credits: 1.25,
									tokens: {
										input: 100,
										output: 50,
									},
									toMessageId: 2,
								},
							],
						},
					}),
				},
			});
			vi.stubEnv('AMP_DATA_DIR', fixture.path);

			await expect(
				loadAmpRows(
					'daily',
					{ offline: true, timezone: 'UTC' },
					{
						pricingFetcher: new LiteLLMPricingFetcher({
							offline: true,
							offlineLoader: async () => ({
								'claude-sonnet-4-20250514': {
									input_cost_per_token: 1e-6,
									output_cost_per_token: 2e-6,
									cache_creation_input_token_cost: 3e-6,
									cache_read_input_token_cost: 1e-7,
								},
							}),
						}),
					},
				),
			).resolves.toMatchObject([
				{
					period: '2026-05-01',
					agent: 'amp',
					modelsUsed: ['claude-sonnet-4-20250514'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
					metadata: { credits: 1.25 },
				},
			]);
		});
	});
}
