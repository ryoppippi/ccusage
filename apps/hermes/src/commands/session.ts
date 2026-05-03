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
import { aggregateGroup, computeTotals, TABLE_COLUMN_COUNT } from '../aggregate-utils.ts';
import { loadHermesSessions, loadHermesSessionMetadata } from '../data-loader.ts';
import { logger } from '../logger.ts';

const ROOT_SENTINEL = Symbol('root');

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

export const sessionCommand = define({
	name: 'session',
	description: 'Show Hermes token usage grouped by session',
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

		const [entries, sessionMetadataMap] = [
			loadHermesSessions(),
			loadHermesSessionMetadata(),
		];

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null })
				: 'No Hermes usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesBySession = groupBy(entries, (entry) => entry.sessionID);

		const sessionData: SessionData[] = [];

		for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
			const agg = await aggregateGroup(sessionEntries, fetcher);
			const metadata = sessionMetadataMap.get(sessionID);
			let lastActivity = sessionEntries[0]!.timestamp;
			for (const entry of sessionEntries) {
				if (entry.timestamp > lastActivity) {
					lastActivity = entry.timestamp;
				}
			}

			sessionData.push({
				sessionID,
				sessionTitle: metadata?.title ?? sessionID,
				parentID: metadata?.parentID ?? null,
				...agg,
				lastActivity,
			});
		}

		sessionData.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

		const totals = computeTotals(sessionData);

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
		console.log('\n📊 Hermes Token Usage Report - Sessions\n');

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

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sessionsByParent = groupBy(sessionData, (s) => s.parentID ?? (ROOT_SENTINEL as any));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const parentSessions: SessionData[] = (sessionsByParent as any)[ROOT_SENTINEL] ?? [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (sessionsByParent as any)[ROOT_SENTINEL];

		function renderSessionRow(session: SessionData, indent: string): void {
			const subSessions = (sessionsByParent as Record<string, SessionData[]>)[session.sessionID];
			const hasChildren = subSessions != null && subSessions.length > 0;
			const displayTitle = hasChildren ? pc.bold(session.sessionTitle) : session.sessionTitle;

			table.push([
				`${indent}${displayTitle}`,
				formatModelsDisplayMultiline(session.modelsUsed),
				formatNumber(session.inputTokens),
				formatNumber(session.outputTokens),
				formatNumber(session.cacheCreationTokens),
				formatNumber(session.cacheReadTokens),
				formatNumber(session.totalTokens),
				formatCurrency(session.totalCost),
			]);

			if (hasChildren) {
				let subtotalInputTokens = session.inputTokens;
				let subtotalOutputTokens = session.outputTokens;
				let subtotalCacheCreationTokens = session.cacheCreationTokens;
				let subtotalCacheReadTokens = session.cacheReadTokens;
				let subtotalTotalTokens = session.totalTokens;
				let subtotalCost = session.totalCost;

				for (const sub of subSessions) {
					renderSessionRow(sub, `${indent}  ↓ `);
					subtotalInputTokens += sub.inputTokens;
					subtotalOutputTokens += sub.outputTokens;
					subtotalCacheCreationTokens += sub.cacheCreationTokens;
					subtotalCacheReadTokens += sub.cacheReadTokens;
					subtotalTotalTokens += sub.totalTokens;
					subtotalCost += sub.totalCost;
				}

				table.push([
					`${indent}  ${pc.dim('Total (with subagents)')}`,
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

		for (const parentSession of parentSessions) {
			renderSessionRow(parentSession, '');
		}

		// Render any orphaned sessions that were never attached to a parent
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const remainingKeys = Object.keys(sessionsByParent).filter((k) => k !== (ROOT_SENTINEL as any).toString());
		for (const key of remainingKeys) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const orphans = (sessionsByParent as any)[key];
			if (orphans != null && orphans.length > 0) {
				for (const orphan of orphans) {
					renderSessionRow(orphan, '');
				}
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
