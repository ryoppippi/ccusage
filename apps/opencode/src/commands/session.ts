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
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { isDateInRange } from '../date-utils.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 8;

export const sessionCommand = define({
	name: 'session',
	description: 'Show OpenCode token usage grouped by session',
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

		const sessionMetadataMap = await loadOpenCodeSessions();

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
				console.log(JSON.stringify({ sessions: [], totals: emptyTotals }, null, 2));
			} else {
				// eslint-disable-next-line no-console
				console.log('No OpenCode usage data found.');
			}
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesBySession = groupBy(entries, (entry) => entry.sessionID);

		type SessionData = {
			sessionID: string;
			sessionTitle: string;
			parentID: string | null;
			inputTokens: number;
			outputTokens: number;
			cacheCreationInputTokens: number;
			cacheReadInputTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: Date;
		};

		const sessionData: SessionData[] = [];

		for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationInputTokens = 0;
			let cacheReadInputTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			let lastActivity = sessionEntries[0]!.timestamp;

			for (const entry of sessionEntries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
				cacheReadInputTokens += entry.usage.cacheReadInputTokens;
				totalCost += await calculateCostForEntry(entry, fetcher);
				modelsSet.add(entry.model);

				if (entry.timestamp > lastActivity) {
					lastActivity = entry.timestamp;
				}
			}

			const totalTokens =
				inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;

			const metadata = sessionMetadataMap.get(sessionID);

			sessionData.push({
				sessionID,
				sessionTitle: metadata?.title ?? sessionID,
				parentID: metadata?.parentID ?? null,
				inputTokens,
				outputTokens,
				cacheCreationInputTokens,
				cacheReadInputTokens,
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
			cacheCreationInputTokens: sessionData.reduce((sum, s) => sum + s.cacheCreationInputTokens, 0),
			cacheReadInputTokens: sessionData.reduce((sum, s) => sum + s.cacheReadInputTokens, 0),
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
				formatNumber(parentSession.cacheCreationInputTokens),
				formatNumber(parentSession.cacheReadInputTokens),
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
						formatNumber(subSession.cacheCreationInputTokens),
						formatNumber(subSession.cacheReadInputTokens),
						formatNumber(subSession.totalTokens),
						formatCurrency(subSession.totalCost),
					]);
				}

				const subtotalInputTokens =
					parentSession.inputTokens + subSessions.reduce((sum, s) => sum + s.inputTokens, 0);
				const subtotalOutputTokens =
					parentSession.outputTokens + subSessions.reduce((sum, s) => sum + s.outputTokens, 0);
				const subtotalCacheCreationInputTokens =
					parentSession.cacheCreationInputTokens +
					subSessions.reduce((sum, s) => sum + s.cacheCreationInputTokens, 0);
				const subtotalCacheReadInputTokens =
					parentSession.cacheReadInputTokens +
					subSessions.reduce((sum, s) => sum + s.cacheReadInputTokens, 0);
				const subtotalTotalTokens =
					parentSession.totalTokens + subSessions.reduce((sum, s) => sum + s.totalTokens, 0);
				const subtotalCost =
					parentSession.totalCost + subSessions.reduce((sum, s) => sum + s.totalCost, 0);

				table.push([
					pc.dim('  Total (with subagents)'),
					'',
					pc.yellow(formatNumber(subtotalInputTokens)),
					pc.yellow(formatNumber(subtotalOutputTokens)),
					pc.yellow(formatNumber(subtotalCacheCreationInputTokens)),
					pc.yellow(formatNumber(subtotalCacheReadInputTokens)),
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
