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
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { buildSessionReport } from '../session-report.ts';

const TABLE_COLUMN_COUNT = 8;

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

		const [entries, sessionMetadataMap] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const sessionData = await buildSessionReport(entries, {
			pricingFetcher: fetcher,
			sessionMetadata: sessionMetadataMap,
		});

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
		console.log('\n📊 OpenCode Token Usage Report - Sessions\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Session',
				'Models',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Session', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		const sessionsByParent = groupBy(sessionData, (s) => s.parentID ?? 'root');
		const parentSessions = sessionsByParent.root ?? [];
		delete sessionsByParent.root;

		for (const parentSession of parentSessions) {
			const isParent = sessionsByParent[parentSession.sessionID] != null;
			const displayTitle = isParent
				? pc.bold(parentSession.sessionTitle)
				: parentSession.sessionTitle;

			table.push([
				displayTitle,
				formatModelsDisplayMultiline(parentSession.modelsUsed),
				formatNumber(parentSession.inputTokens),
				formatNumber(parentSession.outputTokens),
				formatNumber(parentSession.cacheCreationTokens),
				formatNumber(parentSession.cacheReadTokens),
				formatNumber(parentSession.totalTokens),
				formatCurrency(parentSession.totalCost),
			]);

			const subSessions = sessionsByParent[parentSession.sessionID];
			if (subSessions != null && subSessions.length > 0) {
				for (const subSession of subSessions) {
					table.push([
						`  ↳ ${subSession.sessionTitle}`,
						formatModelsDisplayMultiline(subSession.modelsUsed),
						formatNumber(subSession.inputTokens),
						formatNumber(subSession.outputTokens),
						formatNumber(subSession.cacheCreationTokens),
						formatNumber(subSession.cacheReadTokens),
						formatNumber(subSession.totalTokens),
						formatCurrency(subSession.totalCost),
					]);
				}

				const subtotalInputTokens =
					parentSession.inputTokens + subSessions.reduce((sum, s) => sum + s.inputTokens, 0);
				const subtotalOutputTokens =
					parentSession.outputTokens + subSessions.reduce((sum, s) => sum + s.outputTokens, 0);
				const subtotalCacheCreationTokens =
					parentSession.cacheCreationTokens +
					subSessions.reduce((sum, s) => sum + s.cacheCreationTokens, 0);
				const subtotalCacheReadTokens =
					parentSession.cacheReadTokens +
					subSessions.reduce((sum, s) => sum + s.cacheReadTokens, 0);
				const subtotalTotalTokens =
					parentSession.totalTokens + subSessions.reduce((sum, s) => sum + s.totalTokens, 0);
				const subtotalCost =
					parentSession.totalCost + subSessions.reduce((sum, s) => sum + s.totalCost, 0);

				table.push([
					pc.dim('  Total (with subagents)'),
					'',
					pc.yellow(formatNumber(subtotalInputTokens)),
					pc.yellow(formatNumber(subtotalOutputTokens)),
					pc.yellow(formatNumber(subtotalCacheCreationTokens)),
					pc.yellow(formatNumber(subtotalCacheReadTokens)),
					pc.yellow(formatNumber(subtotalTotalTokens)),
					pc.yellow(formatCurrency(subtotalCost)),
				]);
			}
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
