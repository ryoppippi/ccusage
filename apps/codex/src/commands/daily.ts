import type { ResponsiveTable } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
} from '@ccusage/terminal/table';
import { sort } from 'fast-sort';
import { define } from 'gunshi';
import { DEFAULT_LOCALE, DEFAULT_MODEL, DEFAULT_TIMEZONE, MODEL_ENV_VAR } from '../_consts.ts';
import { buildDailyReport } from '../daily-report.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

function splitUsageTokens(usage: {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}): {
	inputTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = usage.outputTokens + usage.reasoningOutputTokens;

	return {
		inputTokens,
		cacheReadTokens,
		outputTokens,
	};
}

function isOptionExplicit(tokens: ReadonlyArray<unknown>, optionName: string): boolean {
	for (const token of tokens) {
		if (typeof token === 'object' && token != null) {
			const candidate = token as { kind?: string; name?: string };
			if (candidate.kind === 'option' && candidate.name === optionName) {
				return true;
			}
		}
	}
	return false;
}

function formatModelsList(models: Record<string, { totalTokens: number }>): string[] {
	return sort(Object.keys(models)).asc();
}

export const dailyCommand = define({
	name: 'daily',
	description: 'Show Codex token usage grouped by day',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output report as JSON',
			default: false,
		},
		since: {
			type: 'string',
			description: 'Filter from date (YYYY-MM-DD or YYYYMMDD)',
		},
		until: {
			type: 'string',
			description: 'Filter until date (inclusive)',
		},
		timezone: {
			type: 'string',
			short: 'z',
			description: 'Timezone for date grouping (IANA)',
			default: DEFAULT_TIMEZONE,
		},
		locale: {
			type: 'string',
			short: 'l',
			description: 'Locale for formatting',
			default: DEFAULT_LOCALE,
		},
		model: {
			type: 'string',
			short: 'm',
			description: `Default model name when Codex log lacks model metadata (defaults to ${DEFAULT_MODEL}, or CODEX_USAGE_MODEL if set)`,
			default: DEFAULT_MODEL,
		},
		offline: {
			type: 'boolean',
			description: 'Use cached pricing data instead of fetching from LiteLLM',
			default: true,
			negatable: true,
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let since: string | undefined;
		let until: string | undefined;

		try {
			since = normalizeFilterDate(ctx.values.since);
			until = normalizeFilterDate(ctx.values.until);
		}
		catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const modelFromEnv = process.env[MODEL_ENV_VAR];
		const modelProvidedViaCli = isOptionExplicit(ctx.tokens, 'model');
		let defaultModel = ctx.values.model ?? DEFAULT_MODEL;
		if (!modelProvidedViaCli && modelFromEnv != null && modelFromEnv !== '') {
			defaultModel = modelFromEnv;
		}

		const { events, missingDirectories } = await loadTokenUsageEvents({
			defaultModel,
		});

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			log(jsonOutput ? JSON.stringify({ daily: [], totals: null }) : 'No Codex usage data found.');
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
		});
		try {
			const rows = await buildDailyReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				defaultModel,
				since,
				until,
			});

			if (rows.length === 0) {
				log(jsonOutput ? JSON.stringify({ daily: [], totals: null }) : 'No Codex usage data found for provided filters.');
				return;
			}

			const totals = rows.reduce((acc, row) => {
				acc.inputTokens += row.inputTokens;
				acc.cachedInputTokens += row.cachedInputTokens;
				acc.outputTokens += row.outputTokens;
				acc.reasoningOutputTokens += row.reasoningOutputTokens;
				acc.totalTokens += row.totalTokens;
				acc.costUSD += row.costUSD;
				return acc;
			}, {
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
				costUSD: 0,
			});

			if (jsonOutput) {
				log(JSON.stringify({
					daily: rows,
					totals,
				}, null, 2));
				return;
			}

			logger.box(`Codex Token Usage Report - Daily (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`);

			const table: ResponsiveTable = createUsageReportTable({
				firstColumnName: 'Date',
			});

			const totalsForDisplay = {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: totals.costUSD,
			};

			for (const row of rows) {
				const split = splitUsageTokens(row);
				totalsForDisplay.inputTokens += split.inputTokens;
				totalsForDisplay.outputTokens += split.outputTokens;
				totalsForDisplay.cacheReadTokens += split.cacheReadTokens;

				const formattedRow = formatUsageDataRow(row.date, {
					inputTokens: split.inputTokens,
					outputTokens: split.outputTokens,
					cacheCreationTokens: 0,
					cacheReadTokens: split.cacheReadTokens,
					totalCost: row.costUSD,
					modelsUsed: formatModelsList(row.models),
				});

				table.push(formattedRow);
			}

			totalsForDisplay.totalCost = totals.costUSD;

			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push(formatTotalsRow(totalsForDisplay));

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
		finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
