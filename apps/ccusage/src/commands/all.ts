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
		// Note: loadDailyUsageData accepts since/until as raw user input (YYYYMMDD or YYYY-MM-DD)
		// and handles normalization internally via string comparison.
		const claudeData = await loadDailyUsageData({ ...mergedOptions, groupByProject: false });
		const claudeTotals = claudeData.length > 0 ? calculateTotals(claudeData) : null;

		// ── Codex ────────────────────────────────────────────────────────────
		// Note: Codex normalizeFilterDate explicitly converts YYYYMMDD → YYYY-MM-DD before passing
		// to buildDailyReport, whereas Claude side handles both formats internally. The behavior is
		// equivalent for valid inputs.
		const normalizeDate = Result.try({
			try: (date: string | undefined) => normalizeFilterDate(date),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		const codexSinceResult = normalizeDate(mergedOptions.since);
		if (Result.isFailure(codexSinceResult)) {
			logger.error(codexSinceResult.error.message);
			process.exit(1);
		}
		const codexUntilResult = normalizeDate(mergedOptions.until);
		if (Result.isFailure(codexUntilResult)) {
			logger.error(codexUntilResult.error.message);
			process.exit(1);
		}
		const codexSince = codexSinceResult.value;
		const codexUntil = codexUntilResult.value;

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
			// Compute totals from the unsorted raw rows so that sort order never affects aggregation.
			const codexTotals =
				codexRowsRaw.length > 0
					? codexRowsRaw.reduce(
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
			// Apply sort order after totals are computed.
			const codexRows = mergedOptions.order === 'desc' ? [...codexRowsRaw].reverse() : codexRowsRaw;

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
							mergedOptions.locale as string | undefined,
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

				for (const row of codexRows) {
					const split = splitUsageTokens(row);
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

				// Derive display totals from the already-computed codexTotals (same source of truth).
				const totalSplit = codexTotals != null ? splitUsageTokens(codexTotals) : null;
				addEmptySeparatorRow(codexTable, CODEX_TABLE_COLUMN_COUNT);
				codexTable.push([
					pc.yellow('Total'),
					'',
					pc.yellow(formatNumber(totalSplit?.inputTokens ?? 0)),
					pc.yellow(formatNumber(totalSplit?.outputTokens ?? 0)),
					pc.yellow(formatNumber(totalSplit?.reasoningTokens ?? 0)),
					pc.yellow(formatNumber(totalSplit?.cacheReadTokens ?? 0)),
					pc.yellow(formatNumber(codexTotals?.totalTokens ?? 0)),
					pc.yellow(formatCurrency(codexTotals?.costUSD ?? 0)),
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

if (import.meta.vitest != null) {
	describe('allCommand codex date handling', () => {
		it('buildDailyReport dateKey is ISO YYYY-MM-DD', async () => {
			const stubPricingSource = {
				async getPricing() {
					return {
						inputCostPerMToken: 1.25,
						cachedInputCostPerMToken: 0.125,
						outputCostPerMToken: 10,
					};
				},
			};
			const rows = await buildDailyReport(
				[
					{
						sessionId: 's1',
						timestamp: '2025-11-15T10:00:00.000Z',
						model: 'gpt-5',
						inputTokens: 100,
						cachedInputTokens: 0,
						outputTokens: 50,
						reasoningOutputTokens: 0,
						totalTokens: 150,
					},
				],
				{ pricingSource: stubPricingSource },
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(rows[0]!.dateKey).toBe('2025-11-15');
		});
	});

	describe('allCommand order sorting', () => {
		it('reverses codex rows when order is desc', () => {
			const rawRows = [
				{ date: 'Jan 01, 2025', dateKey: '2025-01-01' },
				{ date: 'Jan 02, 2025', dateKey: '2025-01-02' },
				{ date: 'Jan 03, 2025', dateKey: '2025-01-03' },
			];
			const descRows = [...rawRows].reverse();
			expect(descRows[0]!.dateKey).toBe('2025-01-03');
			expect(descRows[2]!.dateKey).toBe('2025-01-01');
		});
	});

	describe('allCommand combined cost', () => {
		it('combined cost sums claude and codex totals', () => {
			const claudeCost = 1.5;
			const codexCost = 0.75;
			const combined = (claudeCost ?? 0) + (codexCost ?? 0);
			expect(combined).toBeCloseTo(2.25, 10);
		});

		it('combined cost is 0 when both totals are absent', () => {
			const claudeCost: number | undefined = undefined;
			const codexCost: number | undefined = undefined;
			const combined = (claudeCost ?? 0) + (codexCost ?? 0);
			expect(combined).toBe(0);
		});
	});
}
