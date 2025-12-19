import type { LoadedUsageEntry } from '../data-loader';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadOpenCodeMessages } from '../data-loader';

const TABLE_COLUMN_COUNT = 8;

async function calculateCostForEntry(
	entry: LoadedUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	if (entry.costUSD != null && entry.costUSD > 0) {
		return entry.costUSD;
	}

	const result = await fetcher.calculateCostFromTokens(
		{
			input_tokens: entry.usage.inputTokens,
			output_tokens: entry.usage.outputTokens,
			cache_creation_input_tokens: entry.usage.cacheCreationInputTokens,
			cache_read_input_tokens: entry.usage.cacheReadInputTokens,
		},
		entry.model,
	);

	return Result.unwrap(result, 0);
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show OpenCode token usage grouped by session',
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
			const output = jsonOutput ? JSON.stringify({ sessions: [], totals: null }) : 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false });

		const entriesBySession = groupBy(entries, entry => entry.sessionID);

		const sessionData: Array<{
			sessionID: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: Date;
		}> = [];

		for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			let lastActivity = sessionEntries[0]!.timestamp;

			for (const entry of sessionEntries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += await calculateCostForEntry(entry, fetcher);
				modelsSet.add(entry.model);

				if (entry.timestamp > lastActivity) {
					lastActivity = entry.timestamp;
				}
			}

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			sessionData.push({
				sessionID,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				lastActivity,
			});
		}

		sessionData.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

		const totals = {
			inputTokens: sessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, s) => sum + s.outputTokens, 0),
			cacheCreationTokens: sessionData.reduce((sum, s) => sum + s.cacheCreationTokens, 0),
			cacheReadTokens: sessionData.reduce((sum, s) => sum + s.cacheReadTokens, 0),
			totalTokens: sessionData.reduce((sum, s) => sum + s.totalTokens, 0),
			totalCost: sessionData.reduce((sum, s) => sum + s.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(JSON.stringify({
				sessions: sessionData,
				totals,
			}, null, 2));
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Sessions\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: ['Session ID', 'Models', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total Tokens', 'Cost (USD)'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Session ID', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
		});

		for (const data of sessionData) {
			const shortSessionID = data.sessionID.length > 12 ? `…${data.sessionID.slice(-12)}` : data.sessionID;

			table.push([
				shortSessionID,
				formatModelsDisplayMultiline(data.modelsUsed.map(m => `• ${m}`)),
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
