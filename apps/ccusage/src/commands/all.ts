import type { Args, Command } from 'gunshi';
import type {
	AdapterContext,
	AdapterOptions,
	AdapterProgress,
	AgentId,
	AgentUsageRow,
	ReportKind,
} from '../adapter/types.ts';
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
import { Spinner } from 'picospinner';
import { formatDateCompact, getDateStringWeek } from '../_date-utils.ts';
import {
	aggregateRowsByPeriod,
	detectAllAgents,
	loadAgentRows,
	resolveAllAgents,
} from '../adapter/index.ts';
import { createEmptyRow, getRowAgents } from '../adapter/shared.ts';
import { agentLabels } from '../adapter/types.ts';
import { logger, writeStdoutLine } from '../logger.ts';

type AllRow = AgentUsageRow;
type AllOptions = AdapterOptions;
type AllLoadContext = AdapterContext;
type AllLoadProgress = AdapterProgress;

const allArgs = {
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
} as const satisfies Args;

async function loadAllRowsWithContext(
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
	agents = resolveAllAgents(options),
): Promise<AllRow[]> {
	const rows = (
		await Promise.all(agents.map(async (agent) => loadAgentRows(agent, kind, options, context)))
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
	agents?: AgentId[],
	progress?: AllLoadProgress,
): Promise<AllRow[]> {
	if (options.offline === true) {
		return loadAllRowsWithContext(kind, options, { progress }, agents);
	}

	using pricingFetcher = new LiteLLMPricingFetcher({ logger });
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

function shouldShowAllLoadProgress(options: AllOptions): boolean {
	return options.json !== true && process.stdout.isTTY === true;
}

function formatRowCount(rows: number): string {
	return `${rows} ${rows === 1 ? 'row' : 'rows'}`;
}

function createAllLoadProgress(enabled: boolean): AllLoadProgress | undefined {
	if (!enabled) {
		return undefined;
	}
	const spinners = new Map<AgentId, Spinner>();
	return {
		start(agent) {
			const spinner = new Spinner(`${agentLabels[agent]} :: loading usage logs`);
			spinners.set(agent, spinner);
			spinner.start();
		},
		succeed(agent, rows) {
			const spinner = spinners.get(agent);
			spinner?.succeed(`${agentLabels[agent]} :: ${formatRowCount(rows)}`);
		},
		fail(agent, error) {
			const spinner = spinners.get(agent);
			spinner?.fail(
				`${agentLabels[agent]} :: ${error instanceof Error ? error.message : String(error)}`,
			);
		},
		stop() {
			for (const spinner of spinners.values()) {
				if (spinner.running) {
					spinner.stop();
				}
			}
			spinners.clear();
		},
	};
}

async function runAllReport(kind: ReportKind, options: AllOptions): Promise<void> {
	if (options.json === true) {
		logger.level = 0;
	}

	const title = `Coding Agent Usage Report - ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
	let detectedAgents: AgentId[] | undefined;
	if (options.json !== true) {
		detectedAgents = await detectAllAgents(options);
		const detectedAgentLabels = detectedAgents
			.sort(compareStrings)
			.map((agent) => agentLabels[agent])
			.join(', ');
		logger.box(`${title}\nDetected: ${detectedAgentLabels === '' ? 'None' : detectedAgentLabels}`);
	}

	let rows: AllRow[];
	const progress = createAllLoadProgress(shouldShowAllLoadProgress(options));
	try {
		rows = await loadAllRows(kind, options, detectedAgents, progress);
	} catch (error) {
		progress?.stop();
		logger.error(String(error));
		process.exitCode = 1;
		return;
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
			await runAllReport(kind, ctx.values);
		},
	});
}

export const allDailyCommand = createAllCommand(
	'daily',
	'Show all detected coding agent usage grouped by date',
);
export const allWeeklyCommand = createAllCommand(
	'weekly',
	'Show all detected coding agent usage grouped by week',
);
export const allMonthlyCommand = createAllCommand(
	'monthly',
	'Show all detected coding agent usage grouped by month',
);
export const allSessionCommand = createAllCommand(
	'session',
	'Show all detected coding agent usage grouped by session',
);

if (import.meta.vitest != null) {
	describe('resolveAllAgents', () => {
		it('defaults to all supported agents', () => {
			expect(resolveAllAgents({})).toEqual(['claude', 'codex', 'opencode', 'amp', 'pi']);
		});
	});

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

	describe('shouldShowAllLoadProgress', () => {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

		afterEach(() => {
			if (descriptor == null) {
				delete (process.stdout as { isTTY?: boolean }).isTTY;
				return;
			}
			Object.defineProperty(process.stdout, 'isTTY', descriptor);
		});

		it('does not show progress in JSON mode even on a TTY', () => {
			Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

			expect(shouldShowAllLoadProgress({ json: true })).toBe(false);
		});

		it('shows progress only for table output on a TTY', () => {
			Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

			expect(shouldShowAllLoadProgress({ json: false })).toBe(true);
		});

		it('does not show progress when stdout is not a TTY', () => {
			Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

			expect(shouldShowAllLoadProgress({ json: false })).toBe(false);
		});
	});
}
