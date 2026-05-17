import type { AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { defineAgentLogLoader, formatDateKey } from '../shared.ts';
import { hasOpenClawSessionFiles, loadOpenClawUsageEntries } from './parser.ts';
import { getOpenClawPaths } from './paths.ts';

export async function detectOpenClaw(): Promise<boolean> {
	const roots = getOpenClawPaths();
	if (roots.length === 0) {
		return false;
	}
	return hasOpenClawSessionFiles(roots);
}

const loadOpenClawRowsFromLogs = defineAgentLogLoader({
	agent: 'openclaw',
	loadEntries: async (options: AdapterOptions) => loadOpenClawUsageEntries(options.openClawPath),
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.sessionId,
	getModels: (entry) => [entry.model],
	getUsage: (entry) => ({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheCreationTokens: entry.cacheCreationTokens,
		cacheReadTokens: entry.cacheReadTokens,
		totalTokens: entry.tokenTotal,
		totalCost: entry.cost,
	}),
	getMetadata: (entries, kind) => {
		if (kind !== 'session') {
			return undefined;
		}
		const lastTimestamp = entries
			.map((entry) => entry.timestamp)
			.sort(compareStrings)
			.at(-1);
		const provider = entries.find((entry) => entry.provider != null)?.provider;
		return {
			lastActivity: lastTimestamp == null ? undefined : formatDateKey(lastTimestamp),
			provider,
		};
	},
});

export async function loadOpenClawRows(
	kind: ReportKind,
	options: AdapterOptions,
): Promise<AgentUsageRow[]> {
	return loadOpenClawRowsFromLogs(kind, options, {});
}

if (import.meta.vitest != null) {
	describe('openclaw adapter rows', () => {
		it('loads openclaw JSONL usage into daily rows', async () => {
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'session-id.jsonl': [
								JSON.stringify({
									type: 'model_change',
									provider: 'openai-codex',
									modelId: 'gpt-5.2',
								}),
								JSON.stringify({
									type: 'message',
									message: {
										role: 'assistant',
										usage: {
											input: 100,
											output: 50,
											cacheRead: 10,
											cacheWrite: 20,
											totalTokens: 180,
											cost: { total: 0.05 },
										},
										timestamp: Date.UTC(2026, 3, 22, 1, 2, 3),
									},
								}),
							].join('\n'),
						},
					},
				},
			});

			await expect(
				loadOpenClawRows('daily', {
					openClawPath: fixture.path,
					timezone: 'UTC',
				}),
			).resolves.toMatchObject([
				{
					period: '2026-04-22',
					agent: 'openclaw',
					modelsUsed: ['[openclaw] gpt-5.2'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
					totalCost: 0.05,
				},
			]);
		});

		it('loads openclaw JSONL usage into session rows with metadata', async () => {
			await using fixture = await createFixture({
				agents: {
					main: {
						sessions: {
							'session-id.jsonl': [
								JSON.stringify({
									type: 'model_change',
									provider: 'anthropic',
									modelId: 'claude-sonnet-4',
								}),
								JSON.stringify({
									type: 'message',
									message: {
										role: 'assistant',
										usage: { input: 100, output: 50, totalTokens: 150 },
										timestamp: Date.UTC(2026, 3, 22, 1, 2, 3),
									},
								}),
							].join('\n'),
						},
					},
				},
			});

			await expect(
				loadOpenClawRows('session', {
					openClawPath: fixture.path,
					timezone: 'UTC',
				}),
			).resolves.toMatchObject([
				{
					period: 'session-id',
					agent: 'openclaw',
					metadata: {
						lastActivity: '2026-04-22',
						provider: 'anthropic',
					},
				},
			]);
		});
	});
}
