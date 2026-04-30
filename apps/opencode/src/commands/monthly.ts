import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import { sharedArgs } from '../_shared-args.ts';
import { calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages } from '../data-loader.ts';
import { isDateInRange } from '../date-utils.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 8;

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show OpenCode token usage grouped by month',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);

		if (jsonOutput) {
			logger.level = 0;
		}

		let entries = await loadOpenCodeMessages();

		const since = ctx.values.since ?? null;
		const until = ctx.values.until ?? null;

		if (since != null || until != null) {
			entries = entries.filter((entry) => isDateInRange(entry.timestamp, since, until));
		}

		if (entries.length === 0) {
			if (jsonOutput) {
				const emptyTotals = {
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
					totalTokens: 0,
					totalCost: 0,
				};
				// eslint-disable-next-line no-console
				console.log(JSON.stringify({ monthly: [], totals: emptyTotals }, null, 2));
			} else {
				// eslint-disable-next-line no-console
				console.log('No OpenCode usage data found.');
			}
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByMonth = groupBy(entries, (entry) => entry.timestamp.toISOString().slice(0, 7));

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationInputTokens: number;
			cacheReadInputTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
		}> = [];

		for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationInputTokens = 0;
			let cacheReadInputTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();

			for (const entry of monthEntries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
				cacheReadInputTokens += entry.usage.cacheReadInputTokens;
				totalCost += await calculateCostForEntry(entry, fetcher);
				modelsSet.add(entry.model);
			}

			const totalTokens =
				inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				cacheCreationInputTokens,
				cacheReadInputTokens,
				totalTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
			});
		}

		monthlyData.sort((a, b) => a.month.localeCompare(b.month));

		const totals = {
			inputTokens: monthlyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: monthlyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationInputTokens: monthlyData.reduce((sum, d) => sum + d.cacheCreationInputTokens, 0),
			cacheReadInputTokens: monthlyData.reduce((sum, d) => sum + d.cacheReadInputTokens, 0),
			totalTokens: monthlyData.reduce((sum, d) => sum + d.totalTokens, 0),
			totalCost: monthlyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						monthly: monthlyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Monthly\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Month',
				'Models',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Month', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of monthlyData) {
			table.push([
				data.month,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheCreationInputTokens),
				formatNumber(data.cacheReadInputTokens),
				formatNumber(data.totalTokens),
				formatCurrency(data.totalCost),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheCreationInputTokens)),
			pc.yellow(formatNumber(totals.cacheReadInputTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(formatCurrency(totals.totalCost)),
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
