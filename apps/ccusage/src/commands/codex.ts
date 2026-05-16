import type { Args, Command } from 'gunshi';
import type { AdapterOptions, ReportKind } from '../adapter/types.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { loadCodexReportRows } from '../adapter/codex/index.ts';
import { formatDateCompact } from '../date-utils.ts';
import { logger, writeStdoutLine } from '../logger.ts';
import { createUsageLoadProgress, shouldShowUsageLoadProgress } from './loading-progress.ts';

const codexArgs = {
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output report as JSON',
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
	speed: {
		type: 'string',
		description:
			'Cost speed tier: auto reads Codex config.toml service_tier; use standard or fast to override',
		default: 'auto',
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

type CodexCommandKind = Extract<ReportKind, 'daily' | 'monthly' | 'session'>;
type CodexTotals = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
};

function getRowPeriod(row: Awaited<ReturnType<typeof loadCodexReportRows>>[number]): string {
	if ('date' in row) {
		return row.date;
	}
	if ('month' in row) {
		return row.month;
	}
	return row.sessionId;
}

function getRowsKey(kind: CodexCommandKind): 'daily' | 'monthly' | 'sessions' {
	return kind === 'session' ? 'sessions' : kind;
}

function calculateCodexTotals(rows: Awaited<ReturnType<typeof loadCodexReportRows>>): CodexTotals {
	return rows.reduce<CodexTotals>(
		(total, row) => {
			total.inputTokens += row.inputTokens;
			total.cachedInputTokens += row.cachedInputTokens;
			total.outputTokens += row.outputTokens;
			total.reasoningOutputTokens += row.reasoningOutputTokens;
			total.totalTokens += row.totalTokens;
			total.costUSD += row.costUSD;
			return total;
		},
		{
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens: 0,
			costUSD: 0,
		},
	);
}

async function runCodexReport(kind: CodexCommandKind, options: AdapterOptions): Promise<void> {
	const originalLoggerLevel = logger.level;
	if (options.json === true) {
		logger.level = 0;
	}

	const progress = createUsageLoadProgress(shouldShowUsageLoadProgress(options, process.stdout));
	let rows: Awaited<ReturnType<typeof loadCodexReportRows>>;
	try {
		if (progress != null) {
			logger.level = 0;
		}
		progress?.start('codex');
		rows = await loadCodexReportRows(kind, options, { progress });
		progress?.succeed('codex', rows.length);
	} catch (error) {
		progress?.fail('codex', error);
		progress?.stop();
		logger.level = originalLoggerLevel;
		logger.error(String(error));
		process.exitCode = 1;
		return;
	} finally {
		logger.level = originalLoggerLevel;
	}
	progress?.stop();

	const rowsKey = getRowsKey(kind);
	if (rows.length === 0) {
		await writeStdoutLine(
			options.json === true
				? JSON.stringify({ [rowsKey]: [], totals: null })
				: 'No Codex usage data found.',
		);
		return;
	}

	const totals = calculateCodexTotals(rows);
	if (options.json === true) {
		await writeStdoutLine(
			JSON.stringify(
				{
					[rowsKey]: rows,
					totals,
				},
				null,
				2,
			),
		);
		return;
	}

	const label = kind[0]!.toUpperCase() + kind.slice(1);
	logger.box(`Codex Token Usage Report - ${label}`);
	const table = new ResponsiveTable({
		head: [
			kind === 'monthly' ? 'Month' : kind === 'session' ? 'Session' : 'Date',
			'Models',
			'Input',
			'Output',
			'Reasoning',
			'Cache Read',
			'Total Tokens',
			'Cost (USD)',
		],
		colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
		compactHead: [
			kind === 'monthly' ? 'Month' : kind === 'session' ? 'Session' : 'Date',
			'Models',
			'Input',
			'Output',
			'Cost (USD)',
		],
		compactColAligns: ['left', 'left', 'right', 'right', 'right'],
		minColumnWidths: [12, 14, 11, 11, 11, 11, 11, 14],
		compactMinColumnWidths: [12, 14, 11, 11, 14],
		flexibleColumnIndex: 1,
		compactFlexibleColumnIndex: 1,
		compactThreshold: 100,
		dateFormatter: (dateStr: string) => formatDateCompact(dateStr, options.timezone),
		forceCompact: options.compact === true,
		style: { head: ['cyan'] },
	});

	for (const row of rows) {
		const period = getRowPeriod(row);
		const models = formatModelsDisplayMultiline(Object.keys(row.models));
		if (table.isCompactMode()) {
			table.push([
				period,
				models,
				formatNumber(row.inputTokens),
				formatNumber(row.outputTokens),
				formatCurrency(row.costUSD),
			]);
		} else {
			table.push([
				period,
				models,
				formatNumber(row.inputTokens),
				formatNumber(row.outputTokens),
				formatNumber(row.reasoningOutputTokens),
				formatNumber(row.cachedInputTokens),
				formatNumber(row.totalTokens),
				formatCurrency(row.costUSD),
			]);
		}
	}
	addEmptySeparatorRow(table, 8);
	if (table.isCompactMode()) {
		table.push([
			'Total',
			'',
			formatNumber(totals.inputTokens),
			formatNumber(totals.outputTokens),
			formatCurrency(totals.costUSD),
		]);
	} else {
		table.push([
			'Total',
			'',
			formatNumber(totals.inputTokens),
			formatNumber(totals.outputTokens),
			formatNumber(totals.reasoningOutputTokens),
			formatNumber(totals.cachedInputTokens),
			formatNumber(totals.totalTokens),
			formatCurrency(totals.costUSD),
		]);
	}

	await writeStdoutLine(table.toString());
	if (table.isCompactMode()) {
		await writeStdoutLine();
		logger.info('Running in Compact Mode');
		logger.info('Expand terminal width to see reasoning, cache, and total token metrics');
	}
}

function createCodexCommand(
	kind: CodexCommandKind,
	description: string,
): Command<typeof codexArgs> {
	return define({
		name: kind,
		description,
		args: codexArgs,
		toKebab: true,
		async run(ctx) {
			await runCodexReport(kind, ctx.values);
		},
	});
}

export const codexDailyCommand = createCodexCommand(
	'daily',
	'Show Codex token usage grouped by day',
);
export const codexMonthlyCommand = createCodexCommand(
	'monthly',
	'Show Codex token usage grouped by month',
);
export const codexSessionCommand = createCodexCommand(
	'session',
	'Show Codex token usage grouped by session',
);

if (import.meta.vitest != null) {
	describe('calculateCodexTotals', () => {
		it('keeps cached and reasoning token totals distinct', () => {
			const totals = calculateCodexTotals([
				{
					date: '2026-01-01',
					inputTokens: 10,
					cachedInputTokens: 4,
					outputTokens: 3,
					reasoningOutputTokens: 2,
					totalTokens: 13,
					costUSD: 0.5,
					models: {
						'opus-4': {
							inputTokens: 10,
							cachedInputTokens: 4,
							outputTokens: 3,
							reasoningOutputTokens: 2,
							totalTokens: 13,
							isFallback: false,
						},
					},
				},
			]);

			expect(totals).toEqual({
				inputTokens: 10,
				cachedInputTokens: 4,
				outputTokens: 3,
				reasoningOutputTokens: 2,
				totalTokens: 13,
				costUSD: 0.5,
			});
		});
	});
}
