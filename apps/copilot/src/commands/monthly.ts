import type { PricingMode } from '../_consts.ts';
import type { TokenUsageEvent } from '../_types.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	pushBreakdownRows,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { PREMIUM_REQUEST_COST_USD } from '../_consts.ts';
import {
	expandUntilForDayComparison,
	isWithinRange,
	normalizeFilterDate,
	toDateKey,
	toMonthKey,
} from '../_date-utils.ts';
import { sharedArgs } from '../_shared-args.ts';
import { loadCopilotUsageEvents } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { CopilotPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show Copilot CLI token usage grouped by month',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const modeValue = ctx.values.mode ?? 'premium';
		if (modeValue !== 'premium' && modeValue !== 'api') {
			console.error(`Invalid mode "${modeValue}". Use "premium" or "api".`);
			process.exitCode = 1;
			return;
		}
		const pricingMode: PricingMode = modeValue;
		const timezone = ctx.values.timezone;
		const sortOrder = ctx.values.order === 'desc' ? 'desc' : 'asc';
		const showBreakdown = Boolean(ctx.values.breakdown);

		// Keep full-precision dates for event-level filtering
		let sinceFull: string | undefined;
		let untilFull: string | undefined;
		if (ctx.values.since != null) {
			sinceFull = normalizeFilterDate(ctx.values.since);
		}
		if (ctx.values.until != null) {
			untilFull = expandUntilForDayComparison(normalizeFilterDate(ctx.values.until));
		}

		const { events, missingDirectories } = await loadCopilotUsageEvents();

		for (const missing of missingDirectories) {
			logger.warn(`Copilot session-state directory not found: ${missing}`);
		}

		if (jsonOutput) {
			logger.level = 0;
		}

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ monthly: [], totals: null, mode: pricingMode, missingDirectories })
				: 'No Copilot CLI usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using pricingSource = new CopilotPricingSource({ offline: Boolean(ctx.values.offline) });

		// Group events by month, filtering by full date range first
		const eventsByMonth = new Map<string, TokenUsageEvent[]>();
		for (const event of events) {
			const dateKey = toDateKey(event.timestamp, timezone);
			if (!isWithinRange(dateKey, sinceFull, untilFull)) {
				continue;
			}
			const month = toMonthKey(event.timestamp, timezone);
			const existing = eventsByMonth.get(month);
			if (existing != null) {
				existing.push(event);
			} else {
				eventsByMonth.set(month, [event]);
			}
		}

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			totalTokens: number;
			premiumRequests: number;
			premiumCostUSD: number;
			apiCostUSD: number;
			modelsUsed: string[];
			modelBreakdowns: Array<{
				model: string;
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheWriteTokens: number;
				cost: number;
			}>;
		}> = [];

		for (const [month, monthEvents] of eventsByMonth) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheReadTokens = 0;
			let cacheWriteTokens = 0;
			let premiumRequests = 0;
			let apiCostUSD = 0;
			const modelsSet = new Set<string>();
			const modelMap = new Map<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					cacheReadTokens: number;
					cacheWriteTokens: number;
					cost: number;
				}
			>();

			for (const event of monthEvents) {
				inputTokens += event.inputTokens;
				outputTokens += event.outputTokens;
				cacheReadTokens += event.cacheReadTokens;
				cacheWriteTokens += event.cacheWriteTokens;
				premiumRequests += event.premiumRequestCost;

				let eventCost = 0;
				if (pricingMode === 'api' || jsonOutput) {
					eventCost = await pricingSource.calculateCost(event.model, {
						inputTokens: event.inputTokens,
						outputTokens: event.outputTokens,
						cacheReadTokens: event.cacheReadTokens,
						cacheWriteTokens: event.cacheWriteTokens,
					});
					apiCostUSD += eventCost;
				}

				const breakdownCost =
					pricingMode === 'premium'
						? event.premiumRequestCost * PREMIUM_REQUEST_COST_USD
						: eventCost;

				const existing = modelMap.get(event.model);
				if (existing != null) {
					existing.inputTokens += event.inputTokens;
					existing.outputTokens += event.outputTokens;
					existing.cacheReadTokens += event.cacheReadTokens;
					existing.cacheWriteTokens += event.cacheWriteTokens;
					existing.cost += breakdownCost;
				} else {
					modelMap.set(event.model, {
						inputTokens: event.inputTokens,
						outputTokens: event.outputTokens,
						cacheReadTokens: event.cacheReadTokens,
						cacheWriteTokens: event.cacheWriteTokens,
						cost: breakdownCost,
					});
				}
				modelsSet.add(event.model);
			}

			const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				totalTokens,
				premiumRequests,
				premiumCostUSD: premiumRequests * PREMIUM_REQUEST_COST_USD,
				apiCostUSD,
				modelsUsed: Array.from(modelsSet),
				modelBreakdowns: Array.from(modelMap.entries()).map(([model, data]) => ({
					model,
					...data,
				})),
			});
		}

		if (sortOrder === 'desc') {
			monthlyData.sort((a, b) => b.month.localeCompare(a.month));
		} else {
			monthlyData.sort((a, b) => a.month.localeCompare(b.month));
		}

		const totals = {
			inputTokens: monthlyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: monthlyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheReadTokens: monthlyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			cacheWriteTokens: monthlyData.reduce((sum, d) => sum + d.cacheWriteTokens, 0),
			totalTokens: monthlyData.reduce((sum, d) => sum + d.totalTokens, 0),
			premiumRequests: monthlyData.reduce((sum, d) => sum + d.premiumRequests, 0),
			premiumCostUSD: monthlyData.reduce((sum, d) => sum + d.premiumCostUSD, 0),
			apiCostUSD: monthlyData.reduce((sum, d) => sum + d.apiCostUSD, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						monthly: monthlyData,
						totals,
						mode: pricingMode,
						missingDirectories,
					},
					null,
					2,
				),
			);
			return;
		}

		const modeLabel = pricingMode === 'premium' ? 'Premium Requests' : 'API Equivalent';
		// eslint-disable-next-line no-console
		console.log(`\n📊 Copilot CLI Token Usage Report - Monthly (${modeLabel})\n`);

		const costHeader = pricingMode === 'premium' ? 'Cost (PR)' : 'Cost (API)';

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Month',
				'Models',
				'Input',
				'Output',
				'Cache Write',
				'Cache Read',
				'Total Tokens',
				costHeader,
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Month', 'Models', 'Input', 'Output', costHeader],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
		});

		for (const data of monthlyData) {
			const costValue =
				pricingMode === 'premium'
					? formatCurrency(data.premiumCostUSD)
					: formatCurrency(data.apiCostUSD);

			table.push([
				data.month,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheWriteTokens),
				formatNumber(data.cacheReadTokens),
				formatNumber(data.totalTokens),
				costValue,
			]);

			if (showBreakdown) {
				pushBreakdownRows(
					table,
					data.modelBreakdowns.map((b) => ({
						modelName: b.model,
						inputTokens: b.inputTokens,
						outputTokens: b.outputTokens,
						cacheCreationTokens: b.cacheWriteTokens,
						cacheReadTokens: b.cacheReadTokens,
						cost: b.cost,
					})),
					1,
				);
			}
		}

		const totalCost = pricingMode === 'premium' ? totals.premiumCostUSD : totals.apiCostUSD;

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheWriteTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(formatCurrency(totalCost)),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
