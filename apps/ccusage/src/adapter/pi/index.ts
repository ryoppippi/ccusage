import type { AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { hasFileRecursive } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { defineAgentLogLoader, formatDateKey } from '../shared.ts';
import { loadPiUsageEntries } from './parser.ts';
import { getPiAgentPaths } from './paths.ts';

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return hasFileRecursive(root, { extension });
}

export async function detectPi(): Promise<boolean> {
	const results = await Promise.all(
		getPiAgentPaths().map(async (sessionsPath) => hasFiles(sessionsPath, '.jsonl')),
	);
	return results.some(Boolean);
}

const loadPiRowsFromLogs = defineAgentLogLoader({
	agent: 'pi',
	loadEntries: async (options: AdapterOptions) => loadPiUsageEntries(options.piPath),
	getTimestamp: (entry) => entry.timestamp,
	getSessionId: (entry) => entry.sessionId,
	getModels: (entry) => [entry.model ?? 'unknown'],
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
		return {
			lastActivity: lastTimestamp == null ? undefined : formatDateKey(lastTimestamp),
			projectPath: entries[0]?.project,
		};
	},
});

export async function loadPiRows(
	kind: ReportKind,
	options: AdapterOptions,
): Promise<AgentUsageRow[]> {
	return loadPiRowsFromLogs(kind, options, {});
}

if (import.meta.vitest != null) {
	describe('pi adapter rows', () => {
		it('loads pi-agent JSONL usage into daily rows', async () => {
			await using fixture = await createFixture({
				sessions: {
					project: {
						'session-id.jsonl': `${JSON.stringify({
							type: 'message',
							timestamp: '2026-04-22T01:02:03.000Z',
							message: {
								role: 'assistant',
								model: 'gpt-5.4',
								usage: {
									input: 100,
									output: 50,
									cacheRead: 10,
									cacheWrite: 20,
									totalTokens: 180,
									cost: { total: 0.05 },
								},
							},
						})}\n`,
					},
				},
			});

			await expect(
				loadPiRows('daily', {
					piPath: fixture.getPath('sessions'),
					timezone: 'UTC',
				}),
			).resolves.toMatchObject([
				{
					period: '2026-04-22',
					agent: 'pi',
					modelsUsed: ['[pi] gpt-5.4'],
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					totalTokens: 180,
					totalCost: 0.05,
				},
			]);
		});

		it('loads pi-agent JSONL usage into session rows', async () => {
			await using fixture = await createFixture({
				sessions: {
					project: {
						'session-id.jsonl': `${JSON.stringify({
							type: 'message',
							timestamp: '2026-04-22T01:02:03.000Z',
							message: {
								role: 'assistant',
								model: 'gpt-5.4',
								usage: {
									input: 100,
									output: 50,
								},
							},
						})}\n`,
					},
				},
			});

			await expect(
				loadPiRows('session', {
					piPath: fixture.getPath('sessions'),
					timezone: 'UTC',
				}),
			).resolves.toMatchObject([
				{
					period: 'session-id',
					agent: 'pi',
					metadata: {
						lastActivity: '2026-04-22',
						projectPath: 'project',
					},
				},
			]);
		});
	});
}
