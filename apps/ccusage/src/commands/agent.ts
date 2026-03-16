import type { AgentUsage, ModelBreakdown } from '../data-loader.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatModelsDisplayMultiline,
	pushBreakdownRows,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { uniq } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { deriveAgentId, deriveAgentRole, shortProjectName } from '../agent-id.ts';
import { createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadAgentUsageData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

/**
 * Formats a number in compact form: 999, 1.2K, 12.4K, 1.2M, 12.4M, 1.2B
 * Keeps output short (max ~6 chars) so table columns don't overflow.
 */
function formatCompact(num: number): string {
	if (num < 1_000) {
		return String(num);
	}
	if (num < 1_000_000) {
		const k = num / 1_000;
		return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
	}
	if (num < 1_000_000_000) {
		const m = num / 1_000_000;
		return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
	}
	const b = num / 1_000_000_000;
	return b < 10 ? `${b.toFixed(1)}B` : `${Math.round(b)}B`;
}

/**
 * Formats a Date to YYYYMMDD string in local time (or specified timezone)
 */
function formatLocalDateYYYYMMDD(date: Date, timezone?: string): string {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		...(timezone != null ? { timeZone: timezone } : {}),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return formatter.format(date).replace(/-/g, '');
}

/**
 * Merges two arrays of model breakdowns, summing tokens/cost for matching models
 */
function mergeModelBreakdowns(a: ModelBreakdown[], b: ModelBreakdown[]): ModelBreakdown[] {
	const map = new Map<string, ModelBreakdown>();

	for (const bd of [...a, ...b]) {
		const existing = map.get(bd.modelName);
		if (existing != null) {
			existing.inputTokens += bd.inputTokens;
			existing.outputTokens += bd.outputTokens;
			existing.cacheCreationTokens += bd.cacheCreationTokens;
			existing.cacheReadTokens += bd.cacheReadTokens;
			existing.cost += bd.cost;
		} else {
			map.set(bd.modelName, { ...bd });
		}
	}

	return Array.from(map.values()).sort((x, y) => y.cost - x.cost);
}

/**
 * Aggregates per-instance agent data into role-level summaries.
 * Strips the session hash suffix so all instances of the same role merge.
 * Lead agents are kept separate per session since they represent distinct work.
 */
function aggregateByRole(agentData: AgentUsage[]): AgentUsage[] {
	const roleMap = new Map<string, AgentUsage>();

	for (const agent of agentData) {
		const role = deriveAgentRole({
			teamName: agent.teamName,
			agentName: agent.agentName,
		});

		// Lead agents represent distinct sessions — keep them separate
		const isLead = role === 'lead';
		const key = isLead
			? `${agent.project != null ? `${shortProjectName(agent.project)}/` : ''}${deriveAgentId({ teamName: agent.teamName, agentName: agent.agentName, sessionId: agent.sessionId })}`
			: role;

		const existing = roleMap.get(key);
		if (existing != null) {
			existing.inputTokens += agent.inputTokens;
			existing.outputTokens += agent.outputTokens;
			existing.cacheCreationTokens += agent.cacheCreationTokens;
			existing.cacheReadTokens += agent.cacheReadTokens;
			existing.totalCost += agent.totalCost;
			existing.modelsUsed = uniq([...existing.modelsUsed, ...agent.modelsUsed]);
			existing.modelBreakdowns = mergeModelBreakdowns(
				existing.modelBreakdowns,
				agent.modelBreakdowns,
			);
		} else {
			roleMap.set(key, {
				agentId: key,
				agentName: agent.agentName,
				teamName: agent.teamName,
				sessionId: isLead ? agent.sessionId : undefined,
				project: isLead ? agent.project : undefined,
				inputTokens: agent.inputTokens,
				outputTokens: agent.outputTokens,
				cacheCreationTokens: agent.cacheCreationTokens,
				cacheReadTokens: agent.cacheReadTokens,
				totalCost: agent.totalCost,
				modelsUsed: [...agent.modelsUsed],
				modelBreakdowns: [...agent.modelBreakdowns],
			});
		}
	}

	return Array.from(roleMap.values());
}

export const agentCommand = define({
	name: 'agent',
	description: 'Show usage report grouped by agent identity',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		team: {
			type: 'string',
			short: 't',
			description: 'Filter to a specific team name',
		},
		session: {
			type: 'string',
			description: 'Filter to a specific session ID',
		},
		all: {
			type: 'boolean',
			short: 'a',
			description: 'Show all-time data instead of today only',
			default: false,
		},
		days: {
			type: 'number',
			short: 'D',
			description: 'Show data from the last N days',
		},
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Show per-instance breakdown instead of role grouping',
			default: false,
		},
	},
	async run(ctx) {
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions: typeof ctx.values = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Resolve date range: explicit --since/--until > --days > --all > default (today)
		let since = ctx.values.since;
		const until = ctx.values.until;

		if (since == null && until == null) {
			if (ctx.values.days != null) {
				const now = new Date();
				const daysAgo = new Date(now);
				daysAgo.setDate(daysAgo.getDate() - (ctx.values.days - 1));
				since = formatLocalDateYYYYMMDD(daysAgo, ctx.values.timezone);
			} else if (!ctx.values.all) {
				// Default: today only
				since = formatLocalDateYYYYMMDD(new Date(), ctx.values.timezone);
			}
		}

		logger.start('Loading agent usage data...');

		const agentData = await loadAgentUsageData({
			since,
			until,
			mode: ctx.values.mode,
			offline: ctx.values.offline,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
			teamFilter: ctx.values.team,
			sessionFilter: ctx.values.session,
			onProgress: (step) => logger.start(step),
		});

		logger.success('Data loaded.');

		if (agentData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			} else {
				logger.warn('No agent usage data found.');
			}
			process.exit(0);
		}

		// Role-level grouping (default) vs per-instance view
		const displayData = ctx.values.instances ? agentData : aggregateByRole(agentData);

		// Sort by cost descending (top spenders first)
		displayData.sort((a, b) => b.totalCost - a.totalCost);

		// Calculate totals
		const totals = displayData.reduce(
			(acc, item) => ({
				inputTokens: acc.inputTokens + item.inputTokens,
				outputTokens: acc.outputTokens + item.outputTokens,
				cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
				cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
				totalCost: acc.totalCost + item.totalCost,
			}),
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
			},
		);

		if (useJson) {
			const jsonOutput = {
				agents: displayData.map((data) => ({
					agentId: data.agentId,
					agentName: data.agentName,
					teamName: data.teamName,
					sessionId: data.sessionId,
					project: data.project,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				})),
				totals: createTotalsObject(totals),
			};

			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
			} else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		} else {
			logger.box('Claude Code Token Usage Report - By Agent');

			const headers = [
				'Agent',
				'Models',
				'Input',
				'Output',
				'Cache Write',
				'Cache Read',
				'Total',
				'Cost (USD)',
			];
			const compactHeaders = ['Agent', 'Models', 'Input', 'Output', 'Cost (USD)'];
			const aligns: Array<'left' | 'right'> = [
				'left',
				'left',
				'right',
				'right',
				'right',
				'right',
				'right',
				'right',
			];
			const compactAligns: Array<'left' | 'right'> = ['left', 'left', 'right', 'right', 'right'];

			const table = new ResponsiveTable({
				head: headers,
				style: { head: ['cyan'] },
				colAligns: aligns,
				compactHead: compactHeaders,
				compactColAligns: compactAligns,
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
			});

			for (const data of displayData) {
				const totalTokens =
					data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens;
				table.push([
					data.agentId,
					data.modelsUsed.length > 0 ? formatModelsDisplayMultiline(data.modelsUsed) : '',
					formatCompact(data.inputTokens),
					formatCompact(data.outputTokens),
					formatCompact(data.cacheCreationTokens),
					formatCompact(data.cacheReadTokens),
					formatCompact(totalTokens),
					formatCurrency(data.totalCost),
				]);

				if (ctx.values.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns);
				}
			}

			addEmptySeparatorRow(table, 8);

			const grandTotal =
				totals.inputTokens +
				totals.outputTokens +
				totals.cacheCreationTokens +
				totals.cacheReadTokens;
			table.push([
				pc.yellow('Total'),
				'',
				pc.yellow(formatCompact(totals.inputTokens)),
				pc.yellow(formatCompact(totals.outputTokens)),
				pc.yellow(formatCompact(totals.cacheCreationTokens)),
				pc.yellow(formatCompact(totals.cacheReadTokens)),
				pc.yellow(formatCompact(grandTotal)),
				pc.yellow(formatCurrency(totals.totalCost)),
			]);

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});
