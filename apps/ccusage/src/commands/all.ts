import process from 'node:process';
import { formatModelsList, splitUsageTokens } from '@ccusage/codex/command-utils';
import { buildDailyReport } from '@ccusage/codex/daily-report';
import { loadTokenUsageEvents } from '@ccusage/codex/data-loader';
import { normalizeFilterDate } from '@ccusage/codex/date-utils';
import { CodexPricingSource } from '@ccusage/codex/pricing';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatCurrency,
	formatDateCompact as formatDateCompactCodex,
	formatModelsDisplayMultiline,
	formatNumber,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { calculateTotals, getTotalTokens } from '../calculate-cost.ts';
import { loadDailyUsageData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

const CODEX_TABLE_COLUMN_COUNT = 8;

export const allCommand = define({
	name: 'all',
	description: 'Show combined usage report for Claude Code and Codex',
	...sharedCommandConfig,
	async run(ctx) {
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// ── Claude Code ──────────────────────────────────────────────────────
		const claudeData = await loadDailyUsageData({ ...mergedOptions, groupByProject: false });
		const claudeTotals = claudeData.length > 0 ? calculateTotals(claudeData) : null;

		// ── Codex ────────────────────────────────────────────────────────────
		let codexSince: string | undefined;
		let codexUntil: string | undefined;
		try {
			codexSince = normalizeFilterDate(mergedOptions.since);
			codexUntil = normalizeFilterDate(mergedOptions.until);
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const { events: codexEvents, missingDirectories } = await loadTokenUsageEvents();
		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		const pricingSource = new CodexPricingSource({ offline: Boolean(mergedOptions.offline) });
		try {
			const codexRowsRaw = await buildDailyReport(codexEvents, {
				pricingSource,
				timezone: mergedOptions.timezone,
				locale: mergedOptions.locale as string | undefined,
				since: codexSince,
				until: codexUntil,
			});
			// Apply same sort order as Claude section
			const codexRows = mergedOptions.order === 'desc' ? [...codexRowsRaw].reverse() : codexRowsRaw;

			const codexTotals =
				codexRows.length > 0
					? codexRows.reduce(
							(acc, row) => {
								acc.inputTokens += row.inputTokens;
								acc.cachedInputTokens += row.cachedInputTokens;
								acc.outputTokens += row.outputTokens;
								acc.reasoningOutputTokens += row.reasoningOutputTokens;
								acc.totalTokens += row.totalTokens;
								acc.costUSD += row.costUSD;
								return acc;
							},
							{
								inputTokens: 0,
								cachedInputTokens: 0,
								outputTokens: 0,
								reasoningOutputTokens: 0,
								totalTokens: 0,
								costUSD: 0,
							},
						)
					: null;

			if (useJson) {
				const output = {
					claude: {
						daily: claudeData.map((data) => ({
							date: data.date,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: getTotalTokens(data),
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
						})),
						totals:
							claudeTotals !== null
								? {
										inputTokens: claudeTotals.inputTokens,
										outputTokens: claudeTotals.outputTokens,
										cacheCreationTokens: claudeTotals.cacheCreationTokens,
										cacheReadTokens: claudeTotals.cacheReadTokens,
										totalCost: claudeTotals.totalCost,
									}
								: null,
					},
					codex: {
						daily: codexRows,
						totals: codexTotals,
					},
					combinedCostUSD: (claudeTotals?.totalCost ?? 0) + (codexTotals?.costUSD ?? 0),
				};

				if (mergedOptions.jq != null) {
					const jqResult = await processWithJq(output, mergedOptions.jq);
					if (Result.isFailure(jqResult)) {
						logger.error(jqResult.error.message);
						process.exit(1);
					}
					log(jqResult.value);
				} else {
					log(JSON.stringify(output, null, 2));
				}
				return;
			}

			// ── Claude Code table ────────────────────────────────────────────
			logger.box('Claude Code Token Usage Report - Daily');

			if (claudeData.length === 0) {
				logger.warn('No Claude Code usage data found.');
			} else {
				const tableConfig = {
					firstColumnName: 'Date',
					dateFormatter: (dateStr: string) =>
						formatDateCompact(
							dateStr,
							mergedOptions.timezone,
							(mergedOptions.locale as string | undefined) ?? undefined,
						),
					forceCompact: Boolean(mergedOptions.compact),
				};
				const claudeTable = createUsageReportTable(tableConfig);

				for (const data of claudeData) {
					const row = formatUsageDataRow(data.date, {
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						modelsUsed: data.modelsUsed,
					});
					claudeTable.push(row);
					if (mergedOptions.breakdown) {
						pushBreakdownRows(claudeTable, data.modelBreakdowns);
					}
				}

				addEmptySeparatorRow(claudeTable, 8);
				if (claudeTotals != null) {
					claudeTable.push(
						formatTotalsRow({
							inputTokens: claudeTotals.inputTokens,
							outputTokens: claudeTotals.outputTokens,
							cacheCreationTokens: claudeTotals.cacheCreationTokens,
							cacheReadTokens: claudeTotals.cacheReadTokens,
							totalCost: claudeTotals.totalCost,
						}),
					);
				}
				log(claudeTable.toString());
			}

			// ── Codex table ──────────────────────────────────────────────────
			const timezone =
				mergedOptions.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
			logger.box(`Codex Token Usage Report - Daily (Timezone: ${timezone})`);

			if (codexRows.length === 0) {
				logger.warn('No Codex usage data found.');
			} else {
				const codexTable: ResponsiveTable = new ResponsiveTable({
					head: [
						'Date',
						'Models',
						'Input',
						'Output',
						'Reasoning',
						'Cache Read',
						'Total Tokens',
						'Cost (USD)',
					],
					colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
					compactHead: ['Date', 'Models', 'Input', 'Output', 'Cost (USD)'],
					compactColAligns: ['left', 'left', 'right', 'right', 'right'],
					compactThreshold: 100,
					forceCompact: Boolean(mergedOptions.compact),
					style: { head: ['cyan'] },
					dateFormatter: (dateStr: string) => formatDateCompactCodex(dateStr),
				});

				const codexDisplayTotals = {
					inputTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
					cacheReadTokens: 0,
					totalTokens: 0,
					costUSD: 0,
				};

				for (const row of codexRows) {
					const split = splitUsageTokens(row);
					codexDisplayTotals.inputTokens += split.inputTokens;
					codexDisplayTotals.outputTokens += split.outputTokens;
					codexDisplayTotals.reasoningTokens += split.reasoningTokens;
					codexDisplayTotals.cacheReadTokens += split.cacheReadTokens;
					codexDisplayTotals.totalTokens += row.totalTokens;
					codexDisplayTotals.costUSD += row.costUSD;

					codexTable.push([
						row.date,
						formatModelsDisplayMultiline(formatModelsList(row.models)),
						formatNumber(split.inputTokens),
						formatNumber(split.outputTokens),
						formatNumber(split.reasoningTokens),
						formatNumber(split.cacheReadTokens),
						formatNumber(row.totalTokens),
						formatCurrency(row.costUSD),
					]);
				}

				addEmptySeparatorRow(codexTable, CODEX_TABLE_COLUMN_COUNT);
				codexTable.push([
					pc.yellow('Total'),
					'',
					pc.yellow(formatNumber(codexDisplayTotals.inputTokens)),
					pc.yellow(formatNumber(codexDisplayTotals.outputTokens)),
					pc.yellow(formatNumber(codexDisplayTotals.reasoningTokens)),
					pc.yellow(formatNumber(codexDisplayTotals.cacheReadTokens)),
					pc.yellow(formatNumber(codexDisplayTotals.totalTokens)),
					pc.yellow(formatCurrency(codexDisplayTotals.costUSD)),
				]);

				log(codexTable.toString());
			}

			// ── Combined total ───────────────────────────────────────────────
			const combinedCost = (claudeTotals?.totalCost ?? 0) + (codexTotals?.costUSD ?? 0);
			log('');
			log(pc.bold(`Combined Total Cost: ${pc.green(formatCurrency(combinedCost))}`));
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
