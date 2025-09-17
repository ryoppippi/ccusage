import process from 'node:process';
import Table from 'cli-table3';
import { define } from 'gunshi';
import pc from 'picocolors';
import { DEFAULT_LOCALE, DEFAULT_MODEL, DEFAULT_TIMEZONE, MODEL_ENV_VAR } from '../_consts.ts';
import { buildDailyReport } from '../daily-report.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';
import { formatCurrency, formatTokens } from '../token-utils.ts';

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
			description: 'Default model name when Codex log lacks model metadata',
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
		const defaultModel = ctx.values.model ?? (modelFromEnv != null && modelFromEnv !== '' ? modelFromEnv : DEFAULT_MODEL);

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

			const table = new Table({
				head: ['Date', 'Input', 'Cached', 'Output', 'Reasoning', 'Total', 'Cost (USD)', 'Models'],
				style: {
					border: [],
					head: [],
					compact: false,
				},
			});

			for (const row of rows) {
				const modelsString = Object.entries(row.models)
					.map(([model, usage]) => `${model} (${formatTokens(usage.totalTokens)})`)
					.join(', ');

				table.push([
					row.date,
					formatTokens(row.inputTokens),
					formatTokens(row.cachedInputTokens),
					formatTokens(row.outputTokens),
					formatTokens(row.reasoningOutputTokens),
					formatTokens(row.totalTokens),
					formatCurrency(row.costUSD, ctx.values.locale),
					modelsString,
				]);
			}

			table.push([
				pc.bold('Totals'),
				pc.bold(formatTokens(totals.inputTokens)),
				pc.bold(formatTokens(totals.cachedInputTokens)),
				pc.bold(formatTokens(totals.outputTokens)),
				pc.bold(formatTokens(totals.reasoningOutputTokens)),
				pc.bold(formatTokens(totals.totalTokens)),
				pc.bold(formatCurrency(totals.costUSD, ctx.values.locale)),
				'',
			]);

			logger.info(`Codex Token Usage Report - Daily (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`);
			log(table.toString());
		}
		finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
