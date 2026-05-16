import type { TokenUsageEvent } from '../_types.ts';
import * as pc from '@ccusage/internal/colors';
import { writeStdoutLine } from '@ccusage/internal/logger';
import { compareStrings } from '@ccusage/internal/sort';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { loadAmpUsageEvents } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { AmpPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 9;

function groupByDate(events: TokenUsageEvent[]): Map<string, TokenUsageEvent[]> {
	const grouped = new Map<string, TokenUsageEvent[]>();
	for (const event of events) {
		const date = event.timestamp.split('T')[0]!;
		const existing = grouped.get(date);
		if (existing != null) {
			existing.push(event);
		} else {
			grouped.set(date, [event]);
		}
	}
	return grouped;
}

export const dailyCommand = define({
	name: 'daily',
	description: 'Show Amp token usage grouped by day',
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

		if (!jsonOutput) {
			logger.box('Amp Token Usage Report - Daily');
		}

		const { events } = await loadAmpUsageEvents();

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ daily: [], totals: null })
				: 'No Amp usage data found.';
			await writeStdoutLine(output);
			return;
		}

		using pricingSource = new AmpPricingSource({ offline: Boolean(ctx.values.offline) });

		const eventsByDate = groupByDate(events);

		const dailyData: Array<{
			date: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			credits: number;
			totalCost: number;
			modelsUsed: string[];
		}> = [];

		for (const [date, dayEvents] of eventsByDate) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let credits = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();

			for (const event of dayEvents) {
				inputTokens += event.inputTokens;
				outputTokens += event.outputTokens;
				cacheCreationTokens += event.cacheCreationInputTokens;
				cacheReadTokens += event.cacheReadInputTokens;
				credits += event.credits;

				const cost = await pricingSource.calculateCost(event.model, {
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					cacheCreationInputTokens: event.cacheCreationInputTokens,
					cacheReadInputTokens: event.cacheReadInputTokens,
				});
				totalCost += cost;
				modelsSet.add(event.model);
			}

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			dailyData.push({
				date,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				credits,
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
			credits: dailyData.reduce((sum, d) => sum + d.credits, 0),
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

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Date',
				'Models',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Credits',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Date', 'Models', 'Input', 'Output', 'Credits', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			minColumnWidths: [12, 14, 11, 11, 11, 11, 11, 9, 14],
			compactMinColumnWidths: [12, 14, 11, 11, 9, 14],
			flexibleColumnIndex: 1,
			compactFlexibleColumnIndex: 1,
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of dailyData) {
			table.push([
				data.date,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheCreationTokens),
				formatNumber(data.cacheReadTokens),
				formatNumber(data.totalTokens),
				data.credits.toFixed(2),
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
			pc.yellow(totals.credits.toFixed(2)),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		const renderedTable = table.toString();

		await writeStdoutLine(renderedTable);

		if (table.isCompactMode()) {
			await writeStdoutLine();
			logger.info('Running in Compact Mode');
			logger.info('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
