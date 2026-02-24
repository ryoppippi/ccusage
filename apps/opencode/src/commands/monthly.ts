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
import { calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 8;

type TokenStats = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

type ModelBreakdown = TokenStats & {
	modelName: string;
};

function createModelBreakdowns(modelAggregates: Map<string, TokenStats>): ModelBreakdown[] {
	return Array.from(modelAggregates.entries())
		.map(([modelName, stats]) => ({
			modelName,
			...stats,
		}))
		.sort((a, b) => b.cost - a.cost);
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show OpenCode token usage grouped by month',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
		},
		compact: {
			type: 'boolean',
			description: 'Force compact table mode',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);

		const entries = await loadOpenCodeMessages();

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ monthly: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByMonth = groupBy(entries, (entry) => entry.timestamp.toISOString().slice(0, 7));

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdowns: ModelBreakdown[];
		}> = [];

		for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelAggregates = new Map<string, TokenStats>();
			const defaultStats: TokenStats = {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0,
			};

			for (const entry of monthEntries) {
				const modelName = entry.model ?? 'unknown';
				if (modelName === '<synthetic>') {
					continue;
				}

				const entryInputTokens = entry.usage.inputTokens;
				const entryOutputTokens = entry.usage.outputTokens;
				const entryCacheCreation = entry.usage.cacheCreationInputTokens;
				const entryCacheRead = entry.usage.cacheReadInputTokens;
				const entryCost = await calculateCostForEntry(entry, fetcher);

				inputTokens += entryInputTokens;
				outputTokens += entryOutputTokens;
				cacheCreationTokens += entryCacheCreation;
				cacheReadTokens += entryCacheRead;
				totalCost += entryCost;
				modelsSet.add(modelName);

				const existing = modelAggregates.get(modelName) ?? defaultStats;

				modelAggregates.set(modelName, {
					inputTokens: existing.inputTokens + entryInputTokens,
					outputTokens: existing.outputTokens + entryOutputTokens,
					cacheCreationTokens: existing.cacheCreationTokens + entryCacheCreation,
					cacheReadTokens: existing.cacheReadTokens + entryCacheRead,
					cost: existing.cost + entryCost,
				});
			}

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
			const modelBreakdowns = createModelBreakdowns(modelAggregates);

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				modelBreakdowns,
			});
		}

		monthlyData.sort((a, b) => a.month.localeCompare(b.month));

		const totals = {
			inputTokens: monthlyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: monthlyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: monthlyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: monthlyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
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
				formatNumber(data.cacheCreationTokens),
				formatNumber(data.cacheReadTokens),
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
			pc.yellow(formatNumber(totals.cacheCreationTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
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
