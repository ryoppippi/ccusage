import { groupByToMap } from '@ccusage/internal/array';
import { writeStdoutLine } from '@ccusage/internal/logger';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatDateCompact,
	formatTotalsRow,
	formatUsageDataRow,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 8;

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
		offline: {
			type: 'boolean',
			negatable: true,
			short: 'O',
			description: 'Use cached pricing data',
			default: false,
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);

		const entries = await loadOpenCodeMessages();

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ monthly: [], totals: null })
				: 'No OpenCode usage data found.';
			await writeStdoutLine(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: Boolean(ctx.values.offline), logger });

		const entriesByMonth = groupByToMap(entries, (entry) =>
			entry.timestamp.toISOString().slice(0, 7),
		);

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
		}> = [];

		for (const [month, monthEntries] of entriesByMonth) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();

			for (const entry of monthEntries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += await calculateCostForEntry(entry, fetcher);
				modelsSet.add(entry.model);
			}

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
			});
		}

		monthlyData.sort((a, b) => compareStrings(a.month, b.month));

		const totals = {
			inputTokens: monthlyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: monthlyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: monthlyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: monthlyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalTokens: monthlyData.reduce((sum, d) => sum + d.totalTokens, 0),
			totalCost: monthlyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			await writeStdoutLine(
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

		logger.box('OpenCode Token Usage Report - Monthly');

		const table = createUsageReportTable({
			firstColumnName: 'Month',
			forceCompact: Boolean(ctx.values.compact),
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of monthlyData) {
			table.push(formatUsageDataRow(data.month, data));
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push(formatTotalsRow(totals));
		const renderedTable = table.toString();

		await writeStdoutLine(renderedTable);

		if (table.isCompactMode()) {
			await writeStdoutLine();
			logger.info('Running in Compact Mode');
			logger.info('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
