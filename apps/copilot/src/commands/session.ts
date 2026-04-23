import type { PricingMode } from '../_consts.ts';
import type { TokenUsageEvent } from '../_types.ts';
import path from 'node:path';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	formatNumber,
	pushBreakdownRows,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { PREMIUM_REQUEST_COST_USD } from '../_consts.ts';
import {
	expandUntilForDayComparison,
	isWithinRange,
	normalizeFilterDate,
	toDateKey,
} from '../_date-utils.ts';
import { sharedArgs } from '../_shared-args.ts';
import { loadCopilotUsageEvents } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { CopilotPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

export const sessionCommand = define({
	name: 'session',
	description: 'Show Copilot CLI token usage grouped by session',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const modeValue = ctx.values.mode ?? 'premium';
		if (modeValue !== 'premium' && modeValue !== 'api') {
			console.error(`Invalid mode "${modeValue}". Use "premium" or "api".`);
			process.exitCode = 1;
			return;
		}
		const pricingMode: PricingMode = modeValue;
		const timezone = ctx.values.timezone;
		const sortOrder = ctx.values.order === 'desc' ? 'desc' : 'asc';
		const showBreakdown = Boolean(ctx.values.breakdown);

		let since: string | undefined;
		let until: string | undefined;
		if (ctx.values.since != null) {
			since = normalizeFilterDate(ctx.values.since);
		}
		if (ctx.values.until != null) {
			until = expandUntilForDayComparison(normalizeFilterDate(ctx.values.until));
		}

		const { events, sessions, missingDirectories } = await loadCopilotUsageEvents();

		for (const missing of missingDirectories) {
			logger.warn(`Copilot session-state directory not found: ${missing}`);
		}

		if (jsonOutput) {
			logger.level = 0;
		}

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null, mode: pricingMode, missingDirectories })
				: 'No Copilot CLI usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using pricingSource = new CopilotPricingSource({ offline: Boolean(ctx.values.offline) });

		if (jsonOutput) {
			logger.level = 0;
		}

		// Group events by session, filtering by date range
		const eventsBySession = new Map<string, TokenUsageEvent[]>();
		for (const event of events) {
			const dateKey = toDateKey(event.timestamp, timezone);
			if (!isWithinRange(dateKey, since, until)) {
				continue;
			}
			const existing = eventsBySession.get(event.sessionId);
			if (existing != null) {
				existing.push(event);
			} else {
				eventsBySession.set(event.sessionId, [event]);
			}
		}

		const sessionData: Array<{
			sessionId: string;
			repository: string;
			cwd: string;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			totalTokens: number;
			premiumRequests: number;
			premiumCostUSD: number;
			apiCostUSD: number;
			modelsUsed: string[];
			modelBreakdowns: Array<{
				model: string;
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheWriteTokens: number;
				cost: number;
			}>;
			lastActivity: string;
		}> = [];

		for (const [sessionId, sessionEvents] of eventsBySession) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheReadTokens = 0;
			let cacheWriteTokens = 0;
			let premiumRequests = 0;
			let apiCostUSD = 0;
			const modelsSet = new Set<string>();
			const modelMap = new Map<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					cacheReadTokens: number;
					cacheWriteTokens: number;
					cost: number;
				}
			>();
			let lastActivity = sessionEvents[0]!.timestamp;

			for (const event of sessionEvents) {
				inputTokens += event.inputTokens;
				outputTokens += event.outputTokens;
				cacheReadTokens += event.cacheReadTokens;
				cacheWriteTokens += event.cacheWriteTokens;
				premiumRequests += event.premiumRequestCost;

				let eventCost = 0;
				if (pricingMode === 'api' || jsonOutput) {
					eventCost = await pricingSource.calculateCost(event.model, {
						inputTokens: event.inputTokens,
						outputTokens: event.outputTokens,
						cacheReadTokens: event.cacheReadTokens,
						cacheWriteTokens: event.cacheWriteTokens,
					});
					apiCostUSD += eventCost;
				}

				const breakdownCost =
					pricingMode === 'premium'
						? event.premiumRequestCost * PREMIUM_REQUEST_COST_USD
						: eventCost;

				const existing = modelMap.get(event.model);
				if (existing != null) {
					existing.inputTokens += event.inputTokens;
					existing.outputTokens += event.outputTokens;
					existing.cacheReadTokens += event.cacheReadTokens;
					existing.cacheWriteTokens += event.cacheWriteTokens;
					existing.cost += breakdownCost;
				} else {
					modelMap.set(event.model, {
						inputTokens: event.inputTokens,
						outputTokens: event.outputTokens,
						cacheReadTokens: event.cacheReadTokens,
						cacheWriteTokens: event.cacheWriteTokens,
						cost: breakdownCost,
					});
				}
				modelsSet.add(event.model);

				if (event.timestamp > lastActivity) {
					lastActivity = event.timestamp;
				}
			}

			const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
			const sessionMeta = sessions.get(sessionId);

			sessionData.push({
				sessionId,
				repository: sessionMeta?.repository ?? '',
				cwd: sessionMeta?.cwd ?? '',
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				totalTokens,
				premiumRequests,
				premiumCostUSD: premiumRequests * PREMIUM_REQUEST_COST_USD,
				apiCostUSD,
				modelsUsed: Array.from(modelsSet),
				modelBreakdowns: Array.from(modelMap.entries()).map(([model, data]) => ({
					model,
					...data,
				})),
				lastActivity,
			});
		}

		if (sortOrder === 'desc') {
			sessionData.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
		} else {
			sessionData.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));
		}

		const totals = {
			inputTokens: sessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, s) => sum + s.outputTokens, 0),
			cacheReadTokens: sessionData.reduce((sum, s) => sum + s.cacheReadTokens, 0),
			cacheWriteTokens: sessionData.reduce((sum, s) => sum + s.cacheWriteTokens, 0),
			totalTokens: sessionData.reduce((sum, s) => sum + s.totalTokens, 0),
			premiumRequests: sessionData.reduce((sum, s) => sum + s.premiumRequests, 0),
			premiumCostUSD: sessionData.reduce((sum, s) => sum + s.premiumCostUSD, 0),
			apiCostUSD: sessionData.reduce((sum, s) => sum + s.apiCostUSD, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						sessions: sessionData,
						totals,
						mode: pricingMode,
						missingDirectories,
					},
					null,
					2,
				),
			);
			return;
		}

		const modeLabel = pricingMode === 'premium' ? 'Premium Requests' : 'API Equivalent';
		// eslint-disable-next-line no-console
		console.log(`\n📊 Copilot CLI Token Usage Report - Sessions (${modeLabel})\n`);

		const costHeader = pricingMode === 'premium' ? 'Cost (PR)' : 'Cost (API)';

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Session',
				'Models',
				'Input',
				'Output',
				'Cache Write',
				'Cache Read',
				'Total Tokens',
				costHeader,
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Session', 'Models', 'Input', 'Output', costHeader],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
		});

		for (const data of sessionData) {
			// Handle both POSIX and Windows paths regardless of current platform
			const normalizedCwd = data.cwd.replaceAll('\\', '/');
			const cwdBasename = path.posix.basename(normalizedCwd);
			const displayLabel =
				data.repository !== ''
					? data.repository
					: cwdBasename !== ''
						? cwdBasename
						: data.sessionId.slice(0, 8);

			const truncatedLabel =
				displayLabel.length > 30 ? `${displayLabel.slice(0, 27)}...` : displayLabel;

			const costValue =
				pricingMode === 'premium'
					? formatCurrency(data.premiumCostUSD)
					: formatCurrency(data.apiCostUSD);

			table.push([
				truncatedLabel,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheWriteTokens),
				formatNumber(data.cacheReadTokens),
				formatNumber(data.totalTokens),
				costValue,
			]);

			if (showBreakdown) {
				pushBreakdownRows(
					table,
					data.modelBreakdowns.map((b) => ({
						modelName: b.model,
						inputTokens: b.inputTokens,
						outputTokens: b.outputTokens,
						cacheCreationTokens: b.cacheWriteTokens,
						cacheReadTokens: b.cacheReadTokens,
						cost: b.cost,
					})),
					1,
				);
			}
		}

		const totalCost = pricingMode === 'premium' ? totals.premiumCostUSD : totals.apiCostUSD;

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheWriteTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(formatCurrency(totalCost)),
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
