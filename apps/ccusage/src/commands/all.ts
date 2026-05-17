import type { Args, Command } from 'gunshi';
import type {
	AdapterContext,
	AdapterOptions,
	AgentId,
	AgentUsageRow,
	ReportKind,
} from '../adapter/types.ts';
import type { ConfigData, ConfigMergeContext } from '../config-loader-tokens.ts';
import type { UsageLoadProgress } from './loading-progress.ts';
import process from 'node:process';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { aggregateRowsByPeriod, detectAllAgents, loadAgentRows } from '../adapter/index.ts';
import { createEmptyRow, getRowAgents } from '../adapter/shared.ts';
import { agentIds, agentLabels } from '../adapter/types.ts';
import { loadConfig, mergeConfigWithArgs } from '../config-loader-tokens.ts';
import { formatDateCompact, getDateStringWeek } from '../date-utils.ts';
import { logger, writeStdoutLine } from '../logger.ts';
import { sharedArgs } from '../shared-args.ts';
import { createUsageLoadProgress, shouldShowUsageLoadProgress } from './loading-progress.ts';

type AllRow = AgentUsageRow;
type AllBaseOptions = AdapterOptions & {
	config?: string;
};
type AllOptions = AllBaseOptions & {
	agentOptions?: Partial<Record<AgentId, AdapterOptions>>;
};
type AllLoadContext = AdapterContext;
type AllLoadProgress = UsageLoadProgress;

export const allArgs = {
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output in JSON format',
		default: false,
	},
	since: {
		type: 'string',
		short: 's',
		description: 'Filter from date (YYYY-MM-DD or YYYYMMDD)',
	},
	until: {
		type: 'string',
		short: 'u',
		description: 'Filter until date (inclusive)',
	},
	timezone: {
		type: 'string',
		short: 'z',
		description: 'Timezone for date grouping (IANA)',
	},
	all: {
		type: 'boolean',
		description:
			'Accepted for compatibility; all detected supported agents are included by default',
		default: false,
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
		default: false,
	},
	offline: {
		type: 'boolean',
		negatable: true,
		short: 'O',
		description: 'Use cached pricing data where supported',
		default: false,
	},
	config: sharedArgs.config,
} as const satisfies Args;

function mergeAllOptions(
	kind: ReportKind,
	ctx: ConfigMergeContext<AllBaseOptions>,
	config: ConfigData | undefined,
): AllOptions {
	const baseOptions = mergeConfigWithArgs(ctx, config);
	const agentOptions = Object.fromEntries(
		agentIds.map((agent) => [
			agent,
			mergeConfigWithArgs(
				{
					values: ctx.values,
					tokens: ctx.tokens,
					name: `${agent} ${kind}`,
				},
				config,
			),
		]),
	) as Partial<Record<AgentId, AdapterOptions>>;

	return {
		...baseOptions,
		agentOptions,
	};
}

async function loadAllRowsWithContext(
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
	agents: AgentId[],
): Promise<AllRow[]> {
	const rows = (
		await Promise.all(
			agents.map(async (agent) => {
				const agentOptions = options.agentOptions?.[agent] ?? options;
				return loadAgentRows(agent, kind, agentOptions, context);
			}),
		)
	).flat();
	if (kind === 'weekly') {
		return aggregateRowsByPeriod(rows, (row) => getDateStringWeek(row.period, 1));
	}
	if (kind === 'daily' || kind === 'monthly') {
		return aggregateRowsByPeriod(rows, (row) => row.period);
	}
	return rows.sort(
		(a, b) => compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent),
	);
}

async function loadAllRows(
	kind: ReportKind,
	options: AllOptions,
	agents: AgentId[],
	progress?: AllLoadProgress,
): Promise<AllRow[]> {
	if (options.offline === true) {
		return loadAllRowsWithContext(kind, options, { progress }, agents);
	}

	using pricingFetcher = new LiteLLMPricingFetcher({ logger: progress?.pricingLogger ?? logger });
	return await loadAllRowsWithContext(kind, options, { pricingFetcher, progress }, agents);
}

function calculateTotals(rows: AllRow[]): Omit<AllRow, 'period' | 'agent' | 'modelsUsed'> {
	return rows.reduce(
		(total, row) => {
			total.inputTokens += row.inputTokens;
			total.outputTokens += row.outputTokens;
			total.cacheCreationTokens += row.cacheCreationTokens;
			total.cacheReadTokens += row.cacheReadTokens;
			total.totalTokens += row.totalTokens;
			total.totalCost += row.totalCost;
			return total;
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
			totalCost: 0,
			metadata: undefined,
		},
	);
}

function formatDetectedAgentLabels(rows: AllRow[]): string {
	const detectedAgents = Array.from(new Set(rows.flatMap((row) => getRowAgents(row)))).sort(
		compareStrings,
	);
	return detectedAgents.map((agent) => agentLabels[agent]).join(', ');
}

function toJsonRows(rows: AllRow[]): AllRow[] {
	return rows.map(({ agentBreakdowns: _agentBreakdowns, ...row }) => row);
}

async function runAllReport(kind: ReportKind, options: AllOptions): Promise<void> {
	const originalLoggerLevel = logger.level;
	if (options.json === true) {
		logger.level = 0;
	}

	const title = `Coding (Agent) CLI Usage Report - ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
	const detectedAgents = await detectAllAgents(options);
	if (options.json !== true) {
		const detectedAgentLabels = detectedAgents
			.sort(compareStrings)
			.map((agent) => agentLabels[agent])
			.join(', ');
		logger.box(`${title}\nDetected: ${detectedAgentLabels === '' ? 'None' : detectedAgentLabels}`);
	}

	let rows: AllRow[];
	const progress = createUsageLoadProgress(shouldShowUsageLoadProgress(options, process.stdout));
	try {
		if (progress != null) {
			logger.level = 0;
		}
		rows = await loadAllRows(kind, options, detectedAgents, progress);
	} catch (error) {
		progress?.stop();
		logger.level = originalLoggerLevel;
		logger.error(String(error));
		process.exitCode = 1;
		return;
	} finally {
		logger.level = originalLoggerLevel;
	}
	progress?.stop();

	const totals = calculateTotals(rows);
	if (options.json === true) {
		await writeStdoutLine(
			JSON.stringify(
				{
					[kind]: toJsonRows(rows),
					totals,
				},
				null,
				2,
			),
		);
		return;
	}

	if (rows.length === 0) {
		logger.warn('No usage data found.');
		return;
	}

	const firstColumnName =
		kind === 'monthly'
			? 'Month'
			: kind === 'weekly'
				? 'Week'
				: kind === 'session'
					? 'Session'
					: 'Date';
	const table = createUsageReportTable({
		firstColumnName,
		includeAgent: true,
		dateFormatter: (dateStr: string) => formatDateCompact(dateStr, options.timezone),
		forceCompact: options.compact === true,
	});

	for (const row of rows) {
		table.push(
			formatUsageDataRow(row.period, {
				agent: row.agentBreakdowns == null ? agentLabels[row.agent] : 'All',
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheCreationTokens: row.cacheCreationTokens,
				cacheReadTokens: row.cacheReadTokens,
				totalCost: row.totalCost,
				modelsUsed: row.agentBreakdowns == null ? row.modelsUsed : [],
			}),
		);
		if (row.agentBreakdowns != null) {
			for (const breakdown of row.agentBreakdowns) {
				table.push(
					formatUsageDataRow('', {
						agent: `- ${agentLabels[breakdown.agent]}`,
						inputTokens: breakdown.inputTokens,
						outputTokens: breakdown.outputTokens,
						cacheCreationTokens: breakdown.cacheCreationTokens,
						cacheReadTokens: breakdown.cacheReadTokens,
						totalCost: breakdown.totalCost,
						modelsUsed: breakdown.modelsUsed,
					}),
				);
			}
		}
	}

	addEmptySeparatorRow(table, 9);
	table.push(
		formatTotalsRow(
			{
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
			},
			false,
			true,
		),
	);

	const renderedTable = table.toString();
	await writeStdoutLine(renderedTable);

	if (table.isCompactMode()) {
		await writeStdoutLine();
		logger.info('Running in Compact Mode');
		logger.info('Expand terminal width to see cache metrics and total tokens');
	}
}

function createAllCommand(kind: ReportKind, description: string): Command<typeof allArgs> {
	return define({
		name: kind,
		description,
		args: allArgs,
		toKebab: true,
		async run(ctx) {
			const configPath = typeof ctx.values.config === 'string' ? ctx.values.config : undefined;
			const config = loadConfig(configPath);
			const mergedOptions = mergeAllOptions(
				kind,
				{
					values: ctx.values,
					tokens: ctx.tokens,
					name: kind,
				},
				config,
			);
			await runAllReport(kind, mergedOptions);
		},
	});
}

export const allDailyCommand = createAllCommand(
	'daily',
	'Show all detected coding (agent) CLI usage grouped by date',
);
export const allWeeklyCommand = createAllCommand(
	'weekly',
	'Show all detected coding (agent) CLI usage grouped by week',
);
export const allMonthlyCommand = createAllCommand(
	'monthly',
	'Show all detected coding (agent) CLI usage grouped by month',
);
export const allSessionCommand = createAllCommand(
	'session',
	'Show all detected coding (agent) CLI usage grouped by session',
);

if (import.meta.vitest != null) {
	describe('formatDetectedAgentLabels', () => {
		it('formats unique detected agents in stable order', () => {
			expect(
				formatDetectedAgentLabels([
					createEmptyRow('2026-01-01', 'codex'),
					createEmptyRow('2026-01-01', 'claude'),
					createEmptyRow('2026-01-02', 'codex'),
				]),
			).toBe('Claude, Codex');
		});
	});

	describe('aggregateRowsByPeriod', () => {
		it('groups same-day agent rows into one all row sorted by period', () => {
			const rows = aggregateRowsByPeriod(
				[
					{ ...createEmptyRow('2026-01-02', 'codex'), inputTokens: 10, modelsUsed: ['gpt-5'] },
					{
						...createEmptyRow('2026-01-01', 'amp'),
						outputTokens: 20,
						modelsUsed: ['claude-haiku-4-5-20251001'],
					},
					{
						...createEmptyRow('2026-01-02', 'opencode'),
						cacheReadTokens: 30,
						modelsUsed: ['claude-sonnet-4-20250514'],
					},
				],
				(row) => row.period,
			);

			expect(rows.map((row) => row.period)).toEqual(['2026-01-01', '2026-01-02']);
			expect(rows[1]).toEqual(
				expect.objectContaining({
					agent: 'all',
					inputTokens: 10,
					cacheReadTokens: 30,
					metadata: { agents: ['codex', 'opencode'] },
				}),
			);
		});
	});
}
