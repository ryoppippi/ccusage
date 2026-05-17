import type {
	AdapterContext,
	AdapterOptions,
	AgentId,
	AgentUsageRow,
	ReportKind,
} from './types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { Result } from '@praha/byethrow';
import { detectAmp, loadAmpRows } from './amp/index.ts';
import { detectClaude, loadClaudeRows } from './claude/index.ts';
import { detectCodex, loadCodexRows } from './codex/index.ts';
import { detectOpenCode, loadOpenCodeRows } from './opencode/index.ts';
import { detectPi, loadPiRows } from './pi/index.ts';
import { createEmptyRow, getRowAgents } from './shared.ts';
import { agentIds } from './types.ts';

function addModels(target: Set<string>, models: Iterable<string>): void {
	for (const model of models) {
		target.add(model);
	}
}

export function resolveAllAgents(options: AdapterOptions): AgentId[] {
	void options;
	return [...agentIds];
}

export async function detectAllAgents(options: AdapterOptions): Promise<AgentId[]> {
	void options;
	const [claude, codex, opencode, amp, pi] = resolveDetectedAgents(
		await Promise.allSettled([
			detectClaude(),
			detectCodex(),
			detectOpenCode(),
			detectAmp(),
			detectPi(),
		]),
	);
	const detected: AgentId[] = [];
	if (claude) {
		detected.push('claude');
	}
	if (codex) {
		detected.push('codex');
	}
	if (opencode) {
		detected.push('opencode');
	}
	if (amp) {
		detected.push('amp');
	}
	if (pi) {
		detected.push('pi');
	}
	return detected;
}

function resolveDetectedAgents(
	results: Array<PromiseSettledResult<boolean>>,
): [boolean, boolean, boolean, boolean, boolean] {
	return [
		results[0]?.status === 'fulfilled' ? results[0].value : false,
		results[1]?.status === 'fulfilled' ? results[1].value : false,
		results[2]?.status === 'fulfilled' ? results[2].value : false,
		results[3]?.status === 'fulfilled' ? results[3].value : false,
		results[4]?.status === 'fulfilled' ? results[4].value : false,
	];
}

export function aggregateRowsByPeriod(
	rows: AgentUsageRow[],
	getPeriod: (row: AgentUsageRow) => string,
): AgentUsageRow[] {
	const groups = new Map<
		string,
		{
			row: AgentUsageRow;
			models: Set<string>;
			agents: Set<AgentId>;
			agentBreakdowns: AgentUsageRow[];
		}
	>();
	for (const row of rows) {
		const period = getPeriod(row);
		const group = groups.get(period) ?? {
			row: createEmptyRow(period, 'all'),
			models: new Set(),
			agents: new Set<AgentId>(),
			agentBreakdowns: [],
		};
		if (!groups.has(period)) {
			groups.set(period, group);
		}
		group.row.inputTokens += row.inputTokens;
		group.row.outputTokens += row.outputTokens;
		group.row.cacheCreationTokens += row.cacheCreationTokens;
		group.row.cacheReadTokens += row.cacheReadTokens;
		group.row.totalTokens += row.totalTokens;
		group.row.totalCost += row.totalCost;
		addModels(group.models, row.modelsUsed);
		for (const agent of getRowAgents(row)) {
			group.agents.add(agent);
		}
		group.agentBreakdowns.push({ ...row, period });
	}
	return Array.from(groups.values(), ({ row, models, agents, agentBreakdowns }) => ({
		...row,
		modelsUsed: Array.from(models).sort(compareStrings),
		metadata: { ...row.metadata, agents: Array.from(agents).sort(compareStrings) },
		agentBreakdowns: agentBreakdowns.sort((a, b) => compareStrings(a.agent, b.agent)),
	})).sort((a, b) => compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent));
}

export async function loadAgentRows(
	agent: AgentId,
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	context.progress?.start(agent);
	const result = await Result.try({
		try: loadAgentRowsWithoutProgress(agent, kind, options, context),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		context.progress?.fail(agent, result.error);
		throw result.error;
	}
	context.progress?.succeed(agent, result.value.length);
	return result.value;
}

async function loadAgentRowsWithoutProgress(
	agent: AgentId,
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	switch (agent) {
		case 'claude':
			return loadClaudeRows(kind, options);
		case 'codex':
			return loadCodexRows(kind, options, context);
		case 'opencode':
			return loadOpenCodeRows(kind, options, context);
		case 'amp':
			return loadAmpRows(kind, options, context);
		case 'pi':
			return loadPiRows(kind, options);
	}
	return agent satisfies never;
}

if (import.meta.vitest != null) {
	describe('agent adapter aggregation', () => {
		it('treats rejected detector results as not detected', () => {
			expect(
				resolveDetectedAgents([
					{ status: 'fulfilled', value: true },
					{ status: 'rejected', reason: new Error('missing config') },
					{ status: 'fulfilled', value: false },
					{ status: 'fulfilled', value: true },
					{ status: 'rejected', reason: new Error('permission denied') },
				]),
			).toEqual([true, false, false, true, false]);
		});

		it('groups rows by period and keeps per-agent breakdown rows', () => {
			const rows = aggregateRowsByPeriod(
				[
					{
						...createEmptyRow('2026-01-02', 'codex'),
						inputTokens: 10,
						modelsUsed: ['sonnet-4'],
					},
					{
						...createEmptyRow('2026-01-02', 'claude'),
						outputTokens: 5,
						modelsUsed: ['opus-4'],
					},
				],
				(row) => row.period,
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				period: '2026-01-02',
				agent: 'all',
				inputTokens: 10,
				outputTokens: 5,
				modelsUsed: ['opus-4', 'sonnet-4'],
				metadata: { agents: ['claude', 'codex'] },
			});
			expect(rows[0]!.agentBreakdowns).toHaveLength(2);
		});

		it('defaults to every supported coding agent', () => {
			expect(resolveAllAgents({})).toEqual(['claude', 'codex', 'opencode', 'amp', 'pi']);
		});
	});
}
