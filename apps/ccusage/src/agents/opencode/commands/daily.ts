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

export const dailyCommand = define({
	name: 'daily',
	description: 'Show OpenCode token usage grouped by day',
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
				? JSON.stringify({ daily: [], totals: null })
				: 'No OpenCode usage data found.';
			await writeStdoutLine(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: Boolean(ctx.values.offline), logger });

		const entriesByDate = groupByToMap(
			entries,
			(entry) => entry.timestamp.toISOString().split('T')[0]!,
		);

		const dailyData: Array<{
			date: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
		}> = [];

		for (const [date, dayEntries] of entriesByDate) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();

			for (const entry of dayEntries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += await calculateCostForEntry(entry, fetcher);
				modelsSet.add(entry.model);
			}

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			dailyData.push({
				date,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
			});
		}

		dailyData.sort((a, b) => compareStrings(a.date, b.date));

		const totals = {
			inputTokens: dailyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: dailyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: dailyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: dailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalTokens: dailyData.reduce((sum, d) => sum + d.totalTokens, 0),
			totalCost: dailyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			await writeStdoutLine(
				JSON.stringify(
					{
						daily: dailyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		logger.box('OpenCode Token Usage Report - Daily');

		const table = createUsageReportTable({
			firstColumnName: 'Date',
			forceCompact: Boolean(ctx.values.compact),
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of dailyData) {
			table.push(formatUsageDataRow(data.date, data));
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
