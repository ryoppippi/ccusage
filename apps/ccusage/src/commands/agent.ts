import type { Args, Command } from 'gunshi';
import type {
	AdapterContext,
	AdapterOptions,
	AgentId,
	AgentUsageRow,
	ReportKind,
} from '../adapter/types.ts';
import type { UsageLoadProgress } from './loading-progress.ts';
import process from 'node:process';
import * as pc from '@ccusage/internal/colors';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	formatTotalsRow,
	formatUsageDataRow,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { loadAgentRows } from '../adapter/index.ts';
import { agentLabels } from '../adapter/types.ts';
import { formatDateCompact } from '../date-utils.ts';
import { logger, writeStdoutLine } from '../logger.ts';
import { createUsageLoadProgress, shouldShowUsageLoadProgress } from './loading-progress.ts';

type AgentTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	credits?: number;
};

type AgentJsonRow = {
	date?: string;
	week?: string;
	month?: string;
	sessionId?: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	credits?: number;
	totalCost: number;
	modelsUsed: string[];
	lastActivity?: unknown;
	projectPath?: unknown;
};

const commonAgentArgs = {
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
	offline: {
		type: 'boolean',
		negatable: true,
		short: 'O',
		description: 'Use cached pricing data instead of fetching from LiteLLM',
		default: false,
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
		default: false,
	},
	color: {
		type: 'boolean',
		description: 'Enable colored output (default: auto). FORCE_COLOR=1 has the same effect.',
	},
	noColor: {
		type: 'boolean',
		description: 'Disable colored output (default: auto). NO_COLOR=1 has the same effect.',
	},
} as const satisfies Args;

const piAgentArgs = {
	...commonAgentArgs,
	piPath: {
		type: 'string',
		description: 'Path to pi-agent sessions directory',
	},
} as const satisfies Args;

type AgentCommandKind = Extract<ReportKind, 'daily' | 'weekly' | 'monthly' | 'session'>;

function getJsonKey(kind: AgentCommandKind): 'daily' | 'weekly' | 'monthly' | 'sessions' {
	return kind === 'session' ? 'sessions' : kind;
}

function getPeriodKey(kind: AgentCommandKind): 'date' | 'week' | 'month' | 'sessionId' {
	switch (kind) {
		case 'daily':
			return 'date';
		case 'weekly':
			return 'week';
		case 'monthly':
			return 'month';
		case 'session':
			return 'sessionId';
	}
}

function getCredits(row: AgentUsageRow): number | undefined {
	const credits = row.metadata?.credits;
	return typeof credits === 'number' ? credits : undefined;
}

export function calculateAgentTotals(agent: AgentId, rows: AgentUsageRow[]): AgentTotals {
	const totals = rows.reduce(
		(total, row) => {
			total.inputTokens += row.inputTokens;
			total.outputTokens += row.outputTokens;
			total.cacheCreationTokens += row.cacheCreationTokens;
			total.cacheReadTokens += row.cacheReadTokens;
			total.totalTokens += row.totalTokens;
			total.totalCost += row.totalCost;
			if (agent === 'amp') {
				total.credits = (total.credits ?? 0) + (getCredits(row) ?? 0);
			}
			return total;
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
			credits: agent === 'amp' ? 0 : undefined,
			totalCost: 0,
		} satisfies AgentTotals,
	);
	return agent === 'amp'
		? {
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalTokens: totals.totalTokens,
				credits: totals.credits ?? 0,
				totalCost: totals.totalCost,
			}
		: {
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalTokens: totals.totalTokens,
				totalCost: totals.totalCost,
			};
}

export function toAgentJsonPayload(
	agent: AgentId,
	kind: AgentCommandKind,
	rows: AgentUsageRow[],
): Record<string, unknown> {
	const periodKey = getPeriodKey(kind);
	return {
		[getJsonKey(kind)]: rows.map<AgentJsonRow>((row) => {
			const baseRow = {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheCreationTokens: row.cacheCreationTokens,
				cacheReadTokens: row.cacheReadTokens,
				totalTokens: row.totalTokens,
			};
			const credits = getCredits(row);
			const jsonRow: AgentJsonRow =
				agent === 'amp'
					? {
							[periodKey]: row.period,
							...baseRow,
							credits: credits ?? 0,
							totalCost: row.totalCost,
							modelsUsed: row.modelsUsed,
						}
					: {
							[periodKey]: row.period,
							...baseRow,
							totalCost: row.totalCost,
							modelsUsed: row.modelsUsed,
						};
			if (kind === 'session') {
				if (row.metadata?.lastActivity != null) {
					jsonRow.lastActivity = row.metadata.lastActivity;
				}
				if (row.metadata?.projectPath != null) {
					jsonRow.projectPath = row.metadata.projectPath;
				}
			}
			return jsonRow;
		}),
		totals: rows.length === 0 ? null : calculateAgentTotals(agent, rows),
	};
}

async function loadRows(
	agent: AgentId,
	kind: AgentCommandKind,
	options: AdapterOptions,
	progress?: UsageLoadProgress,
): Promise<AgentUsageRow[]> {
	if (options.offline === true || agent === 'pi') {
		return loadAgentRows(agent, kind, options, { progress });
	}

	using pricingFetcher = new LiteLLMPricingFetcher({
		offline: false,
		logger: progress?.pricingLogger ?? logger,
	});
	const context: AdapterContext = { pricingFetcher, progress };
	return await loadAgentRows(agent, kind, options, context);
}

function getReportLabel(kind: AgentCommandKind): string {
	return kind[0]!.toUpperCase() + kind.slice(1);
}

function getFirstColumnName(kind: AgentCommandKind): string {
	switch (kind) {
		case 'daily':
			return 'Date';
		case 'weekly':
			return 'Week';
		case 'monthly':
			return 'Month';
		case 'session':
			return 'Session';
	}
}

function getNoDataMessage(agent: AgentId): string {
	return `No ${agentLabels[agent]} usage data found.`;
}

function renderAmpTable(
	kind: AgentCommandKind,
	rows: AgentUsageRow[],
	totals: AgentTotals,
	options: AdapterOptions,
): ResponsiveTable {
	const table = new ResponsiveTable({
		head: [
			getFirstColumnName(kind),
			'Models',
			'Input',
			'Output',
			'Cache Create',
			'Cache Read',
			'Total Tokens',
			'Credits',
			'Cost (USD)',
		],
		colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
		compactHead: [getFirstColumnName(kind), 'Models', 'Input', 'Output', 'Credits', 'Cost (USD)'],
		compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
		minColumnWidths: [12, 14, 11, 11, 11, 11, 11, 9, 14],
		compactMinColumnWidths: [12, 14, 11, 11, 9, 14],
		flexibleColumnIndex: 1,
		compactFlexibleColumnIndex: 1,
		compactThreshold: 100,
		forceCompact: options.compact === true,
		style: { head: ['cyan'] },
		dateFormatter: (dateStr: string) => formatDateCompact(dateStr, options.timezone),
	});

	for (const row of rows) {
		table.push([
			row.period,
			formatModelsDisplayMultiline(row.modelsUsed),
			formatNumber(row.inputTokens),
			formatNumber(row.outputTokens),
			formatNumber(row.cacheCreationTokens),
			formatNumber(row.cacheReadTokens),
			formatNumber(row.totalTokens),
			(getCredits(row) ?? 0).toFixed(2),
			formatCurrency(row.totalCost),
		]);
	}

	addEmptySeparatorRow(table, 9);
	table.push([
		pc.yellow('Total'),
		'',
		pc.yellow(formatNumber(totals.inputTokens)),
		pc.yellow(formatNumber(totals.outputTokens)),
		pc.yellow(formatNumber(totals.cacheCreationTokens)),
		pc.yellow(formatNumber(totals.cacheReadTokens)),
		pc.yellow(formatNumber(totals.totalTokens)),
		pc.yellow((totals.credits ?? 0).toFixed(2)),
		pc.yellow(formatCurrency(totals.totalCost)),
	]);
	return table;
}

function renderStandardTable(
	kind: AgentCommandKind,
	rows: AgentUsageRow[],
	totals: AgentTotals,
	options: AdapterOptions,
): ReturnType<typeof createUsageReportTable> {
	const table = createUsageReportTable({
		firstColumnName: getFirstColumnName(kind),
		forceCompact: options.compact === true,
		dateFormatter: (dateStr: string) => formatDateCompact(dateStr, options.timezone),
	});

	for (const row of rows) {
		table.push(
			formatUsageDataRow(row.period, {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheCreationTokens: row.cacheCreationTokens,
				cacheReadTokens: row.cacheReadTokens,
				totalCost: row.totalCost,
				modelsUsed: row.modelsUsed,
			}),
		);
	}

	addEmptySeparatorRow(table, 8);
	table.push(formatTotalsRow(totals));
	return table;
}

async function runAgentReport(
	agent: AgentId,
	kind: AgentCommandKind,
	options: AdapterOptions,
): Promise<void> {
	const originalLoggerLevel = logger.level;
	if (options.json === true) {
		logger.level = 0;
	}

	let rows: AgentUsageRow[];
	const progress = createUsageLoadProgress(shouldShowUsageLoadProgress(options, process.stdout));
	try {
		if (progress != null) {
			logger.level = 0;
		}
		rows = await loadRows(agent, kind, options, progress);
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

	if (rows.length === 0) {
		await writeStdoutLine(
			options.json === true
				? JSON.stringify(toAgentJsonPayload(agent, kind, []))
				: getNoDataMessage(agent),
		);
		return;
	}

	if (options.json === true) {
		await writeStdoutLine(JSON.stringify(toAgentJsonPayload(agent, kind, rows), null, 2));
		return;
	}

	logger.box(`${agentLabels[agent]} Token Usage Report - ${getReportLabel(kind)}`);
	const totals = calculateAgentTotals(agent, rows);
	const table =
		agent === 'amp'
			? renderAmpTable(kind, rows, totals, options)
			: renderStandardTable(kind, rows, totals, options);
	await writeStdoutLine(table.toString());
	if (table.isCompactMode()) {
		await writeStdoutLine();
		logger.info('Running in Compact Mode');
		logger.info('Expand terminal width to see cache metrics and total tokens');
	}
}

function createCommonAgentCommand(
	agent: Exclude<AgentId, 'pi'>,
	kind: AgentCommandKind,
	description: string,
): Command<typeof commonAgentArgs> {
	return define({
		name: kind,
		description,
		args: commonAgentArgs,
		toKebab: true,
		async run(ctx) {
			await runAgentReport(agent, kind, ctx.values);
		},
	});
}

function createPiAgentCommand(
	kind: AgentCommandKind,
	description: string,
): Command<typeof piAgentArgs> {
	return define({
		name: kind,
		description,
		args: piAgentArgs,
		toKebab: true,
		async run(ctx) {
			await runAgentReport('pi', kind, ctx.values);
		},
	});
}

export function createAgentCommand(
	agent: 'pi',
	kind: AgentCommandKind,
	description: string,
): Command<typeof piAgentArgs>;
export function createAgentCommand(
	agent: Exclude<AgentId, 'pi'>,
	kind: AgentCommandKind,
	description: string,
): Command<typeof commonAgentArgs>;
export function createAgentCommand(
	agent: AgentId,
	kind: AgentCommandKind,
	description: string,
): Command<typeof commonAgentArgs> | Command<typeof piAgentArgs> {
	return agent === 'pi'
		? createPiAgentCommand(kind, description)
		: createCommonAgentCommand(agent, kind, description);
}

if (import.meta.vitest != null) {
	describe('agent command adapter rows', () => {
		it('builds daily JSON rows and totals from shared adapter rows', () => {
			const payload = toAgentJsonPayload('opencode', 'daily', [
				{
					period: '2026-05-14',
					agent: 'opencode',
					modelsUsed: ['sonnet-4'],
					inputTokens: 10,
					outputTokens: 20,
					cacheCreationTokens: 30,
					cacheReadTokens: 40,
					totalTokens: 100,
					totalCost: 1.25,
				},
			]);

			expect(payload).toEqual({
				daily: [
					{
						date: '2026-05-14',
						inputTokens: 10,
						outputTokens: 20,
						cacheCreationTokens: 30,
						cacheReadTokens: 40,
						totalTokens: 100,
						totalCost: 1.25,
						modelsUsed: ['sonnet-4'],
					},
				],
				totals: {
					inputTokens: 10,
					outputTokens: 20,
					cacheCreationTokens: 30,
					cacheReadTokens: 40,
					totalTokens: 100,
					totalCost: 1.25,
				},
			});
		});

		it('keeps Amp credits when rows come from the adapter metadata', () => {
			const payload = toAgentJsonPayload('amp', 'monthly', [
				{
					period: '2026-05',
					agent: 'amp',
					modelsUsed: ['opus-4'],
					inputTokens: 10,
					outputTokens: 20,
					cacheCreationTokens: 30,
					cacheReadTokens: 40,
					totalTokens: 100,
					totalCost: 1.25,
					metadata: { credits: 2.5 },
				},
			]);

			expect(payload).toEqual({
				monthly: [
					{
						month: '2026-05',
						inputTokens: 10,
						outputTokens: 20,
						cacheCreationTokens: 30,
						cacheReadTokens: 40,
						totalTokens: 100,
						credits: 2.5,
						totalCost: 1.25,
						modelsUsed: ['opus-4'],
					},
				],
				totals: {
					inputTokens: 10,
					outputTokens: 20,
					cacheCreationTokens: 30,
					cacheReadTokens: 40,
					totalTokens: 100,
					credits: 2.5,
					totalCost: 1.25,
				},
			});
		});
	});
}
