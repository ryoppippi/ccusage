import { groupByToMap } from '@ccusage/internal/array';
import * as pc from '@ccusage/internal/colors';
import { writeStdoutLine } from '@ccusage/internal/logger';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatDateCompact,
	formatTotalsRow,
	formatUsageDataRow,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { logger } from '../logger.ts';

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

		const [entries, sessionMetadataMap] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null })
				: 'No OpenCode usage data found.';
			await writeStdoutLine(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: Boolean(ctx.values.offline), logger });

		const entriesBySession = groupByToMap(entries, (entry) => entry.sessionID);

		type SessionData = {
			sessionID: string;
			sessionTitle: string;
			parentID: string | null;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: Date;
		};

		const sessionData: SessionData[] = [];

		for (const [sessionID, sessionEntries] of entriesBySession) {
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

			const metadata = sessionMetadataMap.get(sessionID);

			sessionData.push({
				sessionID,
				sessionTitle: metadata?.title ?? sessionID,
				parentID: metadata?.parentID ?? null,
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
			await writeStdoutLine(
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

		logger.box('OpenCode Token Usage Report - Sessions');

		const table = createUsageReportTable({
			firstColumnName: 'Session',
			forceCompact: Boolean(ctx.values.compact),
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		const sessionsByParent = groupByToMap(sessionData, (s) => s.parentID ?? 'root');
		const parentSessions = sessionsByParent.get('root') ?? [];

		for (const parentSession of parentSessions) {
			const isParent = sessionsByParent.has(parentSession.sessionID);
			const displayTitle = isParent
				? pc.bold(parentSession.sessionTitle)
				: parentSession.sessionTitle;

			table.push([
				...formatUsageDataRow(displayTitle, {
					inputTokens: parentSession.inputTokens,
					outputTokens: parentSession.outputTokens,
					cacheCreationTokens: parentSession.cacheCreationTokens,
					cacheReadTokens: parentSession.cacheReadTokens,
					totalCost: parentSession.totalCost,
					modelsUsed: parentSession.modelsUsed,
				}),
			]);

			const subSessions = sessionsByParent.get(parentSession.sessionID);
			if (subSessions != null && subSessions.length > 0) {
				for (const subSession of subSessions) {
					table.push([
						...formatUsageDataRow(`  - ${subSession.sessionTitle}`, {
							inputTokens: subSession.inputTokens,
							outputTokens: subSession.outputTokens,
							cacheCreationTokens: subSession.cacheCreationTokens,
							cacheReadTokens: subSession.cacheReadTokens,
							totalCost: subSession.totalCost,
							modelsUsed: subSession.modelsUsed,
						}),
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
				const subtotalCost =
					parentSession.totalCost + subSessions.reduce((sum, s) => sum + s.totalCost, 0);

				table.push([
					...formatUsageDataRow(pc.dim('  Total (with subagents)'), {
						inputTokens: subtotalInputTokens,
						outputTokens: subtotalOutputTokens,
						cacheCreationTokens: subtotalCacheCreationTokens,
						cacheReadTokens: subtotalCacheReadTokens,
						totalCost: subtotalCost,
						modelsUsed: [],
					}),
				]);
			}
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
