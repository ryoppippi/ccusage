import type { AgentPricingContext } from '../shared.ts';
import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { createAgentPricingContext, defineAgentLogLoader, formatDateKey } from '../shared.ts';
import { loadCopilotUsageEntries } from './parser.ts';
import { detectCopilotOtelFiles } from './paths.ts';
import { calculateCopilotCost } from './pricing.ts';

export async function detectCopilot(): Promise<boolean> {
	return detectCopilotOtelFiles();
}

function createCopilotPricingContext(
	options: AdapterOptions,
	context: AdapterContext,
): AgentPricingContext {
	return createAgentPricingContext(
		context,
		() =>
			new LiteLLMPricingFetcher({
				offline: options.offline === true,
				logger,
			}),
	);
}

const loadCopilotRowsFromLogs = defineAgentLogLoader<
	Awaited<ReturnType<typeof loadCopilotUsageEntries>>[number],
	AgentPricingContext
>({
	agent: 'copilot',
	loadEntries: async () => loadCopilotUsageEntries(),
	prepare: createCopilotPricingContext,
	disposePrepared: (prepared) => {
		prepared.dispose();
	},
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.sessionId,
	getModels: (entry) => [entry.model],
	getUsage: async (entry, prepared) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: entry.cacheCreationTokens,
		cacheReadTokens: entry.cacheReadTokens,
		totalTokens: entry.totalTokens,
		totalCost: await calculateCopilotCost(entry, prepared.fetcher),
	}),
	getMetadata: (entries, kind) => {
		if (kind !== 'session') {
			return undefined;
		}
		const lastTimestamp = entries
			.map((entry) => entry.timestamp)
			.sort()
			.at(-1);
		return {
			lastActivity: lastTimestamp == null ? undefined : formatDateKey(lastTimestamp),
		};
	},
});

export async function loadCopilotRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	return loadCopilotRowsFromLogs(kind, options, context);
}

if (import.meta.vitest != null) {
	describe('copilot adapter rows', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads Copilot OTEL usage into daily rows', async () => {
			await using fixture = await createFixture({
				otel: {
					'copilot.jsonl': `${JSON.stringify({
						type: 'span',
						traceId: 'trace-1',
						spanId: 'span-1',
						name: 'chat claude-sonnet-4',
						endTime: [1_775_934_264, 967_317_833],
						attributes: {
							'gen_ai.operation.name': 'chat',
							'gen_ai.response.model': 'claude-sonnet-4',
							'gen_ai.conversation.id': 'conv-1',
							'gen_ai.usage.input_tokens': 100,
							'gen_ai.usage.output_tokens': 50,
							'gen_ai.usage.cache_read.input_tokens': 10,
						},
					})}\n`,
				},
			});
			vi.stubEnv('COPILOT_OTEL_FILE_EXPORTER_PATH', fixture.getPath('otel/copilot.jsonl'));

			await expect(
				loadCopilotRows(
					'daily',
					{ timezone: 'UTC' },
					{
						pricingFetcher: new LiteLLMPricingFetcher({
							offline: true,
							offlineLoader: async () => ({}),
						}),
					},
				),
			).resolves.toMatchObject([
				{
					period: '2026-04-11',
					agent: 'copilot',
					modelsUsed: ['claude-sonnet-4'],
					inputTokens: 90,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 10,
					totalTokens: 150,
				},
			]);
		});

		it('calculates Copilot costs from model pricing', async () => {
			await using fixture = await createFixture({
				otel: {
					'copilot.jsonl': `${JSON.stringify({
						type: 'span',
						traceId: 'trace-1',
						spanId: 'span-1',
						name: 'chat test-model',
						endTime: [1_775_934_264, 967_317_833],
						attributes: {
							'gen_ai.operation.name': 'chat',
							'gen_ai.response.model': 'test-model',
							'gen_ai.conversation.id': 'conv-1',
							'gen_ai.usage.input_tokens': 100,
							'gen_ai.usage.output_tokens': 50,
							'gen_ai.usage.cache_read.input_tokens': 10,
							'gen_ai.usage.cache_creation.input_tokens': 20,
							'gen_ai.usage.reasoning.output_tokens': 5,
						},
					})}\n`,
				},
			});
			vi.stubEnv('COPILOT_OTEL_FILE_EXPORTER_PATH', fixture.getPath('otel/copilot.jsonl'));

			await expect(
				loadCopilotRows(
					'daily',
					{ timezone: 'UTC' },
					{
						pricingFetcher: new LiteLLMPricingFetcher({
							offline: true,
							offlineLoader: async () => ({
								'test-model': {
									input_cost_per_token: 1,
									output_cost_per_token: 2,
									cache_creation_input_token_cost: 3,
									cache_read_input_token_cost: 4,
								},
							}),
						}),
					},
				),
			).resolves.toMatchObject([
				{
					inputTokens: 90,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 175,
					totalCost: 300,
				},
			]);
		});
	});
}
