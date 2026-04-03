import process from 'node:process';
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
import { DEFAULT_TIMEZONE } from '../_consts.ts';
import { sharedArgs } from '../_shared-args.ts';
import {
	createEmptyReportPayload,
	formatModelsList,
	groupRowsByProject,
	splitUsageTokens,
} from '../command-utils.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import {
	formatDisplayDate,
	formatDisplayDateTime,
	normalizeFilterDate,
	toDateKey,
} from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';
import { buildSessionReport } from '../session-report.ts';

const TABLE_COLUMN_COUNT_DEFAULT = 11;
const TABLE_COLUMN_COUNT_WITH_PROJECT = 12;

export const sessionCommand = define({
	name: 'session',
	description: 'Show Codex token usage grouped by session',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let since: string | undefined;
		let until: string | undefined;

		try {
			since = normalizeFilterDate(ctx.values.since);
			until = normalizeFilterDate(ctx.values.until);
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const projectFilter = ctx.values.project;
		const useInstances = Boolean(ctx.values.instances);
		const { events, missingDirectories } = await loadTokenUsageEvents();

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			log(
				jsonOutput
					? JSON.stringify(createEmptyReportPayload('sessions', useInstances))
					: 'No Codex usage data found.',
			);
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
		});
		try {
			const rows = await buildSessionReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
				project: projectFilter,
				groupByProject: useInstances,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify(createEmptyReportPayload('sessions', useInstances))
						: 'No Codex usage data found for provided filters.',
				);
				return;
			}

			const totals = rows.reduce(
				(acc, row) => {
					acc.inputTokens += row.inputTokens;
					acc.cachedInputTokens += row.cachedInputTokens;
					acc.outputTokens += row.outputTokens;
					acc.reasoningOutputTokens += row.reasoningOutputTokens;
					acc.totalTokens += row.totalTokens;
					acc.costUSD += row.costUSD;
					return acc;
				},
				{
					inputTokens: 0,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
					costUSD: 0,
				},
			);

			if (jsonOutput) {
				if (useInstances) {
					log(JSON.stringify({ projects: groupRowsByProject(rows), totals }, null, 2));
				} else {
					log(JSON.stringify({ sessions: rows, totals }, null, 2));
				}
				return;
			}

			logger.box(
				`Codex Token Usage Report - Sessions (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const showProject = useInstances && rows.some((r) => r.project != null);
			const columnCount = showProject
				? TABLE_COLUMN_COUNT_WITH_PROJECT
				: TABLE_COLUMN_COUNT_DEFAULT;

			const baseHead = ['Date', 'Directory', 'Session'];
			const baseAligns: ('left' | 'right')[] = ['left', 'left', 'left'];
			const baseCompactHead = ['Date', 'Directory', 'Session'];
			const baseCompactAligns: ('left' | 'right')[] = ['left', 'left', 'left'];

			if (showProject) {
				baseHead.splice(1, 0, 'Project');
				baseAligns.splice(1, 0, 'left');
				baseCompactHead.splice(1, 0, 'Project');
				baseCompactAligns.splice(1, 0, 'left');
			}

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					...baseHead,
					'Models',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
				],
				colAligns: [
					...baseAligns,
					'left',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'left',
				],
				compactHead: [...baseCompactHead, 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: [...baseCompactAligns, 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});

			const totalsForDisplay = {
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				totalTokens: 0,
				costUSD: 0,
			};

			for (const row of rows) {
				const split = splitUsageTokens(row);
				totalsForDisplay.inputTokens += split.inputTokens;
				totalsForDisplay.outputTokens += split.outputTokens;
				totalsForDisplay.reasoningTokens += split.reasoningTokens;
				totalsForDisplay.cacheReadTokens += split.cacheReadTokens;
				totalsForDisplay.totalTokens += row.totalTokens;
				totalsForDisplay.costUSD += row.costUSD;

				const dateKey = toDateKey(row.lastActivity, ctx.values.timezone);
				const displayDate = formatDisplayDate(dateKey, ctx.values.locale, ctx.values.timezone);
				const directoryDisplay = row.directory === '' ? '-' : row.directory;
				const sessionFile = row.sessionFile;
				const shortSession = sessionFile.length > 8 ? `…${sessionFile.slice(-8)}` : sessionFile;

				const baseColumns = [displayDate];
				if (showProject) {
					baseColumns.push(row.project ?? '(unknown)');
				}
				baseColumns.push(directoryDisplay, shortSession);

				table.push([
					...baseColumns,
					formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(split.inputTokens),
					formatNumber(split.outputTokens),
					formatNumber(split.reasoningTokens),
					formatNumber(split.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
					formatDisplayDateTime(row.lastActivity, ctx.values.locale, ctx.values.timezone),
				]);
			}

			addEmptySeparatorRow(table, columnCount);
			const totalPrefix = showProject
				? ['', '', '', pc.yellow('Total')]
				: ['', '', pc.yellow('Total')];
			table.push([
				...totalPrefix,
				'',
				pc.yellow(formatNumber(totalsForDisplay.inputTokens)),
				pc.yellow(formatNumber(totalsForDisplay.outputTokens)),
				pc.yellow(formatNumber(totalsForDisplay.reasoningTokens)),
				pc.yellow(formatNumber(totalsForDisplay.cacheReadTokens)),
				pc.yellow(formatNumber(totalsForDisplay.totalTokens)),
				pc.yellow(formatCurrency(totalsForDisplay.costUSD)),
				'',
			]);

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info(
					'Expand terminal width to see directories, cache metrics, total tokens, and last activity',
				);
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});
