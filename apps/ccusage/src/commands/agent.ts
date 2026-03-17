import type { AgentUsage, ModelBreakdown } from '../data-loader.ts';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
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
import { getClaudePaths, loadAgentUsageData } from '../data-loader.ts';
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
 * Two-pass approach: first identifies named members by sessionId,
 * then resolves lead entries to their named roles when possible.
 * Unresolved leads get a temporary key for later title resolution.
 */
function aggregateByRole(agentData: AgentUsage[]): AgentUsage[] {
	// Pass 1: map sessionId → named role from entries with agentName
	const namedSessionMap = new Map<string, { teamName: string | undefined; agentName: string }>();
	for (const agent of agentData) {
		if (agent.agentName != null && agent.sessionId != null) {
			namedSessionMap.set(agent.sessionId, {
				teamName: agent.teamName,
				agentName: agent.agentName,
			});
		}
	}

	// Pass 2: aggregate, resolving leads to named roles when possible
	const roleMap = new Map<string, AgentUsage>();

	for (const agent of agentData) {
		const role = deriveAgentRole({
			teamName: agent.teamName,
			agentName: agent.agentName,
		});

		const isLead = role === 'lead';
		let key: string;
		let entryAgentName = agent.agentName;
		let entryTeamName = agent.teamName;
		let entrySessionId: string | undefined;
		let entryProject: string | undefined;

		if (isLead) {
			// Check if this lead's session has a named team member
			const named = agent.sessionId != null ? namedSessionMap.get(agent.sessionId) : undefined;
			if (named != null) {
				key = deriveAgentRole({ teamName: named.teamName, agentName: named.agentName });
				entryAgentName = named.agentName;
				entryTeamName = named.teamName;
			} else {
				// Unresolvable lead — temporary key, title resolved in post-processing
				key = `lead:${agent.sessionId ?? 'unknown'}`;
				entrySessionId = agent.sessionId;
				entryProject = agent.project;
			}
		} else {
			key = role;
		}

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
				agentName: entryAgentName,
				teamName: entryTeamName,
				sessionId: entrySessionId,
				project: entryProject,
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

/**
 * Truncates a string to maxLen, breaking at the last space before the limit.
 */
function truncateAtWord(str: string, maxLen: number): string {
	if (str.length <= maxLen) {
		return str;
	}
	const lastSpace = str.lastIndexOf(' ', maxLen);
	return lastSpace > 0 ? str.slice(0, lastSpace) : str.slice(0, maxLen);
}

/**
 * Extracts a short descriptive title from a compaction summary text.
 * Compaction summaries are plain text starting with "This session is being continued..."
 * followed by "Summary:\n1. Primary Request and Intent:\n   - <description>".
 */
function extractCompactionTitle(text: string): string | null {
	// Look for "Primary Request and Intent:" section and grab the first content line after it
	const primaryMatch = text.match(/Primary Request and Intent[:\s]*\n(.+)/i);
	if (primaryMatch?.[1] != null) {
		const line = primaryMatch[1].replace(/^[-\s*]+/, '').trim();
		if (line.length > 0) {
			return truncateAtWord(line, 60);
		}
	}

	// Fallback: find "Summary:" section and grab first meaningful line
	const summaryIdx = text.indexOf('Summary:');
	if (summaryIdx >= 0) {
		const afterSummary = text.slice(summaryIdx + 'Summary:'.length);
		const lines = afterSummary.split('\n');
		for (const rawLine of lines) {
			const line = rawLine.replace(/^[\d.)\-*\s#]+/, '').trim();
			if (line.length === 0) {
				continue;
			}
			// Skip section headers
			if (/^(?:Primary|Key|Current|Important)\s/i.test(line)) {
				continue;
			}
			return truncateAtWord(line, 60);
		}
	}

	return null;
}

/**
 * Resolves a session title from JSONL file content.
 * Priority: cached title > compaction summary (isCompactSummary user entry)
 * > legacy summary > slug > first user message.
 */
async function resolveSessionTitle(
	sessionId: string,
	project: string | undefined,
	claudePaths: string[],
): Promise<{ title: string; startTime: string } | null> {
	const cacheDir = path.join(os.homedir(), '.claude', 'session-titles');
	const cachePath = path.join(cacheDir, sessionId);

	// Check cache — versioned format: "v6\n<title>\n<startTime>"
	const CACHE_VERSION = 'v6';
	try {
		const cached = await readFile(cachePath, 'utf-8');
		const lines = cached.trim().split('\n');
		if (
			lines[0] === CACHE_VERSION &&
			lines.length >= 3 &&
			lines[1] != null &&
			lines[1] !== '' &&
			lines[2] != null &&
			lines[2] !== ''
		) {
			return { title: lines[1], startTime: lines[2] };
		}
		// Stale cache (old format) — fall through to re-derive
	} catch {
		// No cache — continue to derive
	}

	// Find the JSONL file
	let jsonlPath: string | null = null;
	for (const cp of claudePaths) {
		if (project != null) {
			const candidate = path.join(cp, 'projects', project, `${sessionId}.jsonl`);
			try {
				await stat(candidate);
				jsonlPath = candidate;
				break;
			} catch {
				// File not found at this path
			}
		}
	}

	if (jsonlPath == null) {
		return null;
	}

	let slug: string | null = null;
	let compactionTitle: string | null = null;
	let summaryTitle: string | null = null;
	let userMessageTitle: string | null = null;
	let startTime: string | null = null;

	// Phase 1: quick scan of first 50 lines for slug, startTime, userMessage, and early compaction
	const fileStream1 = createReadStream(jsonlPath, { encoding: 'utf-8' });
	const rl1 = createInterface({
		input: fileStream1,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	let lineCount = 0;
	for await (const line of rl1) {
		if (line.trim().length === 0) {
			continue;
		}
		lineCount++;
		if (lineCount > 50) {
			break;
		}

		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;

			if (startTime == null && typeof parsed.timestamp === 'string') {
				startTime = parsed.timestamp;
			}
			if (slug == null && typeof parsed.slug === 'string') {
				slug = parsed.slug;
			}
			// Check for compaction summary in early lines too
			if (compactionTitle == null && parsed.type === 'user' && parsed.isCompactSummary === true) {
				const msg = parsed.message as Record<string, unknown> | undefined;
				if (msg?.role === 'user' && typeof msg.content === 'string') {
					compactionTitle = extractCompactionTitle(msg.content);
				}
			}
			if (summaryTitle == null && parsed.type === 'summary' && typeof parsed.summary === 'string') {
				summaryTitle = parsed.summary.slice(0, 60).trim();
			}
			if (userMessageTitle == null && parsed.type === 'user') {
				const msg = parsed.message as Record<string, unknown> | undefined;
				if (msg?.role === 'user') {
					const content = msg.content;
					if (typeof content === 'string' && !/^<[a-z]/i.test(content)) {
						userMessageTitle = content.split('\n')[0]!.slice(0, 60).trim();
					}
				}
			}
		} catch {
			// Skip unparseable lines
		}
	}

	rl1.close();
	fileStream1.destroy();

	// Phase 2: if no compaction title yet, fast-scan the whole file for isCompactSummary lines
	if (compactionTitle == null) {
		const fileStream2 = createReadStream(jsonlPath, { encoding: 'utf-8' });
		const rl2 = createInterface({
			input: fileStream2,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of rl2) {
			// Cheap string check before expensive JSON.parse
			if (!line.includes('"isCompactSummary"')) {
				continue;
			}
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.type === 'user' && parsed.isCompactSummary === true) {
					const msg = parsed.message as Record<string, unknown> | undefined;
					if (msg?.role === 'user' && typeof msg.content === 'string') {
						compactionTitle = extractCompactionTitle(msg.content);
						if (compactionTitle != null) {
							break;
						}
					}
				}
			} catch {
				// Skip unparseable lines
			}
		}

		rl2.close();
		fileStream2.destroy();
	}

	// Pick best title: compaction summary > legacy summary > slug > user message
	const title = compactionTitle ?? summaryTitle ?? slug ?? userMessageTitle;
	if (title == null || startTime == null) {
		return null;
	}

	// Cache the derived title (versioned format)
	try {
		await mkdir(cacheDir, { recursive: true });
		await writeFile(cachePath, `${CACHE_VERSION}\n${title}\n${startTime}`, 'utf-8');
	} catch {
		// Cache write failure is non-fatal
	}

	return { title, startTime };
}

function formatStartTime(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-GB', {
		...(timezone != null ? { timeZone: timezone } : {}),
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	return formatter.format(date);
}

/**
 * Replaces temporary `lead:sessionId` agentIds with meaningful session titles.
 * Falls back to project/lead-hash when title can't be derived.
 */
async function resolveLeadDisplayNames(agents: AgentUsage[], timezone?: string): Promise<void> {
	let claudePaths: string[] | null = null;

	for (const agent of agents) {
		if (!agent.agentId.startsWith('lead:') || agent.sessionId == null) {
			continue;
		}

		// Lazy-load claude paths
		if (claudePaths == null) {
			try {
				claudePaths = getClaudePaths();
			} catch {
				claudePaths = [];
			}
		}

		const titleInfo = await resolveSessionTitle(agent.sessionId, agent.project, claudePaths);
		if (titleInfo != null) {
			agent.agentId = `${titleInfo.title} · ${formatStartTime(titleInfo.startTime, timezone)}`;
		} else {
			// Fallback: project/lead-hash
			const prefix = agent.project != null ? `${shortProjectName(agent.project)}/` : '';
			agent.agentId = `${prefix}${deriveAgentId({ sessionId: agent.sessionId })}`;
		}
	}
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
				logger.debug('No agent usage data found.');
			}
			process.exit(0);
		}

		// Role-level grouping (default) vs per-instance view
		const displayData = ctx.values.instances ? agentData : aggregateByRole(agentData);

		// Resolve lead display names (session titles) for aggregated view
		if (!ctx.values.instances) {
			await resolveLeadDisplayNames(displayData, ctx.values.timezone);
		}

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
				colWidthOverrides: { 0: 36 },
				compactHead: compactHeaders,
				compactColAligns: compactAligns,
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
			});

			for (const data of displayData) {
				const totalTokens =
					data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens;
				// Insert newline after '/' so team/member names wrap at semantic boundary
				const displayName = data.agentId.includes('/')
					? data.agentId.replace('/', '/\n')
					: data.agentId;
				table.push([
					displayName,
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
