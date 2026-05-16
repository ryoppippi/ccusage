import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createEmptyRow, formatDateKey, isWithinRange, normalizeDateFilter } from '../shared.ts';
import { loadOpenCodeMessages } from './loader.ts';
import { detectOpenCodeSources, getOpenCodePath } from './paths.ts';
import { calculateOpenCodeCost } from './pricing.ts';

export async function detectOpenCode(): Promise<boolean> {
	const openCodePath = getOpenCodePath();
	return openCodePath != null && (await detectOpenCodeSources(openCodePath));
}

export async function loadOpenCodeRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const entries = await loadOpenCodeMessages();
	using ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({ offline: options.offline === true, logger })
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher;
	const groups = new Map<string, { row: AgentUsageRow; models: Set<string> }>();

	for (const entry of entries) {
		const date = formatDateKey(entry.timestamp.toISOString(), options.timezone);
		if (!isWithinRange(date, since, until)) {
			continue;
		}
		const period =
			kind === 'session' ? entry.sessionID : kind === 'monthly' ? date.slice(0, 7) : date;
		const group = groups.get(period) ?? {
			row: createEmptyRow(period, 'opencode'),
			models: new Set(),
		};
		if (!groups.has(period)) {
			groups.set(period, group);
		}
		group.row.inputTokens += entry.usage.inputTokens;
		group.row.outputTokens += entry.usage.outputTokens;
		group.row.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
		group.row.cacheReadTokens += entry.usage.cacheReadInputTokens;
		group.row.totalTokens +=
			entry.usage.inputTokens +
			entry.usage.outputTokens +
			entry.usage.cacheCreationInputTokens +
			entry.usage.cacheReadInputTokens;
		group.row.totalCost += await calculateOpenCodeCost(entry, fetcher);
		group.models.add(entry.model);
	}

	return Array.from(groups.values(), ({ row, models }) => ({
		...row,
		modelsUsed: Array.from(models).sort(compareStrings),
	})).sort((a, b) => compareStrings(a.period, b.period));
}

if (import.meta.vitest != null) {
	describe('loadOpenCodeRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('aggregates OpenCode message usage into daily rows', async () => {
			await using fixture = await createFixture({
				storage: {
					message: {
						'message.json': JSON.stringify({
							id: 'msg-1',
							sessionID: 'session-a',
							providerID: 'openai',
							modelID: 'gpt-5',
							time: { created: Date.UTC(2026, 4, 1, 1, 2, 3) },
							tokens: {
								input: 100,
								output: 50,
								cache: {
									write: 20,
									read: 10,
								},
							},
							cost: 0.02,
						}),
					},
				},
			});
			vi.stubEnv('OPENCODE_DATA_DIR', fixture.path);

			await expect(
				loadOpenCodeRows('daily', { offline: true, timezone: 'UTC' }, {}),
			).resolves.toMatchObject([
				{
					period: '2026-05-01',
					agent: 'opencode',
					modelsUsed: ['gpt-5'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
					totalCost: 0.02,
				},
			]);
		});
	});
}
