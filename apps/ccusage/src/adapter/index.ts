import type {
	AdapterContext,
	AdapterOptions,
	AgentId,
	AgentUsageRow,
	ReportKind,
} from './types.ts';
import { compareStrings } from '@ccusage/internal/sort';
import { detectAmp, loadAmpRows } from './amp.ts';
import { detectClaude, loadClaudeRows } from './claude.ts';
import { detectCodex, loadCodexRows } from './codex.ts';
import { detectOpenCode, loadOpenCodeRows } from './opencode.ts';
import { detectPi, loadPiRows } from './pi.ts';
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
	const [claude, codex, opencode, amp, pi] = await Promise.all([
		detectClaude(),
		detectCodex(),
		detectOpenCode(),
		detectAmp(),
		detectPi(),
	]);
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
	try {
		const rows = await loadAgentRowsWithoutProgress(agent, kind, options, context);
		context.progress?.succeed(agent, rows.length);
		return rows;
	} catch (error) {
		context.progress?.fail(agent, error);
		throw error;
	}
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
}

if (import.meta.vitest != null) {
	describe('agent adapter aggregation', () => {
		it('groups rows by period and keeps per-agent breakdown rows', () => {
			const rows = aggregateRowsByPeriod(
				[
					{ ...createEmptyRow('2026-01-02', 'codex'), inputTokens: 10, modelsUsed: ['gpt-5'] },
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
				modelsUsed: ['gpt-5', 'opus-4'],
				metadata: { agents: ['claude', 'codex'] },
			});
			expect(rows[0]!.agentBreakdowns).toHaveLength(2);
		});

		it('defaults to every supported coding agent', () => {
			expect(resolveAllAgents({})).toEqual(['claude', 'codex', 'opencode', 'amp', 'pi']);
		});
	});
}
