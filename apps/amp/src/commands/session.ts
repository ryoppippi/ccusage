import type { TokenUsageEvent } from '../_types.ts';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadAmpUsageEvents } from '../data-loader.ts';
import { AmpPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 9;

function groupByThread(events: TokenUsageEvent[]): Map<string, TokenUsageEvent[]> {
	const grouped = new Map<string, TokenUsageEvent[]>();
	for (const event of events) {
		const existing = grouped.get(event.threadId);
		if (existing != null) {
			existing.push(event);
		} else {
			grouped.set(event.threadId, [event]);
		}
	}
	return grouped;
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show Amp token usage grouped by thread (session)',
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
		human: {
			type: 'boolean',
			short: 'H',
			description: 'Display token counts in human-readable format (K/M/B suffixes)',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const humanReadable = Boolean(ctx.values.human);

		const { events, threads } = await loadAmpUsageEvents();

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null })
				: 'No Amp usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using pricingSource = new AmpPricingSource({ offline: false });

		const eventsByThread = groupByThread(events);

		const sessionData: Array<{
			threadId: string;
			title: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			credits: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: string;
		}> = [];

		for (const [threadId, threadEvents] of eventsByThread) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let credits = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			let lastActivity = threadEvents[0]!.timestamp;

			for (const event of threadEvents) {
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

				if (event.timestamp > lastActivity) {
					lastActivity = event.timestamp;
				}
			}

			const totalTokens = inputTokens + outputTokens;
			const threadInfo = threads.get(threadId);

			sessionData.push({
				threadId,
				title: threadInfo?.title ?? 'Untitled',
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				credits,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				lastActivity,
			});
		}

		sessionData.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));

		const totals = {
			inputTokens: sessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, s) => sum + s.outputTokens, 0),
			cacheCreationTokens: sessionData.reduce((sum, s) => sum + s.cacheCreationTokens, 0),
			cacheReadTokens: sessionData.reduce((sum, s) => sum + s.cacheReadTokens, 0),
			totalTokens: sessionData.reduce((sum, s) => sum + s.totalTokens, 0),
			credits: sessionData.reduce((sum, s) => sum + s.credits, 0),
			totalCost: sessionData.reduce((sum, s) => sum + s.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						sessions: sessionData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 Amp Token Usage Report - Sessions (Threads)\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Thread',
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
			compactHead: ['Thread', 'Models', 'Input', 'Output', 'Credits', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of sessionData) {
			// Truncate title for display
			const displayTitle = data.title.length > 30 ? `${data.title.slice(0, 27)}...` : data.title;

			table.push([
				displayTitle,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens, humanReadable),
				formatNumber(data.outputTokens, humanReadable),
				formatNumber(data.cacheCreationTokens, humanReadable),
				formatNumber(data.cacheReadTokens, humanReadable),
				formatNumber(data.totalTokens, humanReadable),
				data.credits.toFixed(2),
				formatCurrency(data.totalCost),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens, humanReadable)),
			pc.yellow(formatNumber(totals.outputTokens, humanReadable)),
			pc.yellow(formatNumber(totals.cacheCreationTokens, humanReadable)),
			pc.yellow(formatNumber(totals.cacheReadTokens, humanReadable)),
			pc.yellow(formatNumber(totals.totalTokens, humanReadable)),
			pc.yellow(totals.credits.toFixed(2)),
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
