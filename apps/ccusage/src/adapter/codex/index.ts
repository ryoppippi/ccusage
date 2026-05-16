import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import type { CodexGroup, CodexModelUsage, CodexReportRow } from './types.ts';
import { isDirectorySyncSafe } from '@ccusage/internal/fs';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import {
	createEmptyRow,
	formatDateKey,
	formatMonthKey,
	isWithinRange,
	normalizeDateFilter,
} from '../shared.ts';
import { loadTokenUsageEvents } from './parser.ts';
import { getCodexSessionsPath } from './paths.ts';
import {
	calculateCodexCostUSD,
	CODEX_PROVIDER_PREFIXES,
	getCodexPricing,
	loadOfflineCodexPricing,
	resolveCodexSpeed,
} from './pricing.ts';
import { addCodexUsage, createCodexUsage } from './usage.ts';

export { detectCodex } from './paths.ts';
export type { CodexModelUsage, CodexReportRow } from './types.ts';

type CodexPricing = Awaited<ReturnType<typeof getCodexPricing>>;

type AggregatedCodexUsage = {
	groups: Map<string, CodexGroup>;
	pricingByModel: Map<string, CodexPricing>;
};

async function aggregateCodexUsageGroups(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AggregatedCodexUsage> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const speed = await resolveCodexSpeed(options.speed);
	const events = await loadTokenUsageEvents();
	const ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({
					offline: options.offline === true,
					offlineLoader: loadOfflineCodexPricing,
					logger: context.progress?.pricingLogger ?? logger,
					providerPrefixes: CODEX_PROVIDER_PREFIXES,
				})
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher!;
	try {
		const groups = new Map<string, CodexGroup>();
		for (const event of events) {
			const modelName = event.model?.trim();
			if (modelName == null || modelName === '') {
				continue;
			}
			const date = formatDateKey(event.timestamp, options.timezone);
			if (!isWithinRange(date, since, until)) {
				continue;
			}
			const period =
				kind === 'session'
					? event.sessionId
					: kind === 'monthly'
						? formatMonthKey(event.timestamp, options.timezone)
						: date;
			const group = groups.get(period) ?? {
				row: createEmptyRow(period, 'codex'),
				models: new Map<string, CodexModelUsage>(),
				reasoningOutputTokens: 0,
				lastActivity: event.timestamp,
			};
			if (!groups.has(period)) {
				groups.set(period, group);
			}

			group.row.inputTokens += event.inputTokens;
			group.row.outputTokens += event.outputTokens;
			group.row.cacheReadTokens += event.cachedInputTokens;
			group.row.totalTokens += event.totalTokens;
			group.reasoningOutputTokens += event.reasoningOutputTokens;
			if (event.timestamp > group.lastActivity) {
				group.lastActivity = event.timestamp;
			}

			const modelUsage = group.models.get(modelName) ?? createCodexUsage();
			if (!group.models.has(modelName)) {
				group.models.set(modelName, modelUsage);
			}
			addCodexUsage(modelUsage, event);
			if (event.isFallbackModel === true) {
				modelUsage.isFallback = true;
			}
		}

		const pricingByModel = new Map<string, CodexPricing>();
		for (const group of groups.values()) {
			for (const model of group.models.keys()) {
				if (!pricingByModel.has(model)) {
					pricingByModel.set(model, await getCodexPricing(model, fetcher, speed));
				}
			}
		}

		return { groups, pricingByModel };
	} finally {
		ownedFetcher?.[Symbol.dispose]();
	}
}

function calculateCodexGroupCost(
	models: Map<string, CodexModelUsage>,
	pricingByModel: Map<string, CodexPricing>,
): number {
	let totalCost = 0;
	for (const [model, usage] of models) {
		const pricing = pricingByModel.get(model);
		if (pricing != null) {
			totalCost += calculateCodexCostUSD(usage, pricing);
		}
	}
	return totalCost;
}

export async function loadCodexRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const { groups, pricingByModel } = await aggregateCodexUsageGroups(kind, options, context);
	return Array.from(groups.values(), ({ row, models, reasoningOutputTokens, lastActivity }) => ({
		...row,
		totalCost: calculateCodexGroupCost(models, pricingByModel),
		modelsUsed: Array.from(models.keys()).sort(compareStrings),
		metadata: { lastActivity, reasoningOutputTokens },
	})).sort((a, b) => compareStrings(a.period, b.period));
}

export async function loadCodexReportRows(
	kind: Extract<ReportKind, 'daily' | 'monthly' | 'session'>,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<CodexReportRow[]> {
	const { groups, pricingByModel } = await aggregateCodexUsageGroups(kind, options, context);
	return Array.from(groups.entries(), ([period, group]) => {
		const { row, reasoningOutputTokens, lastActivity } = group;
		const models: Record<string, CodexModelUsage> = {};
		for (const [model, usage] of group.models) {
			models[model] = { ...usage };
		}
		const base = {
			inputTokens: row.inputTokens,
			cachedInputTokens: row.cacheReadTokens,
			outputTokens: row.outputTokens,
			reasoningOutputTokens,
			totalTokens: row.totalTokens,
			costUSD: calculateCodexGroupCost(group.models, pricingByModel),
			models,
		};
		if (kind === 'daily') {
			return { date: period, ...base };
		}
		if (kind === 'monthly') {
			return { month: period, ...base };
		}
		const separatorIndex = period.lastIndexOf('/');
		return {
			sessionId: period,
			lastActivity,
			sessionFile: separatorIndex >= 0 ? period.slice(separatorIndex + 1) : period,
			directory: separatorIndex >= 0 ? period.slice(0, separatorIndex) : '',
			...base,
		};
	}).sort((a, b) => {
		const aKey = 'date' in a ? a.date : 'month' in a ? a.month : a.lastActivity;
		const bKey = 'date' in b ? b.date : 'month' in b ? b.month : b.lastActivity;
		return compareStrings(aKey, bKey);
	});
}

if (import.meta.vitest != null) {
	describe('loadCodexRows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads and aggregates Codex JSONL usage inside ccusage adapter', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2026-01-01T00:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2026-01-01T00:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 20,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 110,
									},
									total_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 20,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 110,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			vi.stubEnv('CODEX_HOME', fixture.path);
			const rows = await loadCodexRows(
				'daily',
				{ offline: true, timezone: 'UTC' },
				{
					pricingFetcher: new LiteLLMPricingFetcher({
						offline: true,
						offlineLoader: async () => ({
							'gpt-5': {
								input_cost_per_token: 1e-6,
								output_cost_per_token: 2e-6,
								cache_read_input_token_cost: 1e-7,
							},
						}),
					}),
				},
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				period: '2026-01-01',
				agent: 'codex',
				modelsUsed: ['gpt-5'],
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 20,
				totalTokens: 110,
			});
			expect(rows[0]!.totalCost).toBeCloseTo(0.000084);
		});

		it('uses the Codex log total token field for all-agent rows so direct and all reports stay consistent when reasoning tokens are present', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2026-01-01T00:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2026-01-01T00:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 20,
										output_tokens: 10,
										reasoning_output_tokens: 70,
										total_tokens: 180,
									},
								},
							},
						}),
					].join('\n'),
				},
			});
			vi.stubEnv('CODEX_HOME', fixture.path);
			const pricingFetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
						cache_read_input_token_cost: 1e-7,
					},
				}),
			});

			const [allRows, reportRows] = await Promise.all([
				loadCodexRows('daily', { offline: true, timezone: 'UTC' }, { pricingFetcher }),
				loadCodexReportRows('daily', { offline: true, timezone: 'UTC' }, { pricingFetcher }),
			]);

			expect(allRows[0]?.totalTokens).toBe(180);
			expect(reportRows[0]?.totalTokens).toBe(180);
		});

		it('keeps Codex-specific JSON report totals on the fast adapter path', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2026-01-02T00:00:00.000Z',
							type: 'turn_context',
							payload: { model: 'gpt-5' },
						}),
						JSON.stringify({
							timestamp: '2026-01-02T00:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 30,
										output_tokens: 11,
										reasoning_output_tokens: 3,
										total_tokens: 131,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			vi.stubEnv('CODEX_HOME', fixture.path);
			const rows = await loadCodexReportRows(
				'daily',
				{ offline: true, timezone: 'UTC' },
				{
					pricingFetcher: new LiteLLMPricingFetcher({
						offline: true,
						offlineLoader: async () => ({
							'gpt-5': {
								input_cost_per_token: 1e-6,
								output_cost_per_token: 2e-6,
								cache_read_input_token_cost: 1e-7,
							},
						}),
					}),
				},
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toEqual({
				date: '2026-01-02',
				inputTokens: 120,
				cachedInputTokens: 30,
				outputTokens: 11,
				reasoningOutputTokens: 3,
				totalTokens: 131,
				costUSD: rows[0]!.costUSD,
				models: {
					'gpt-5': {
						inputTokens: 120,
						cachedInputTokens: 30,
						outputTokens: 11,
						reasoningOutputTokens: 3,
						totalTokens: 131,
						isFallback: false,
					},
				},
			});
			expect(rows[0]!.costUSD).toBeCloseTo(0.000115);
		});

		it.skipIf(!isDirectorySyncSafe(getCodexSessionsPath()))(
			'loads local Codex usage rows when the user has a sessions directory',
			async () => {
				const rows = await loadCodexRows('daily', { offline: true, timezone: 'UTC' }, {});

				expect(rows.length).toBeGreaterThan(0);
			},
			30_000,
		);
	});
}
