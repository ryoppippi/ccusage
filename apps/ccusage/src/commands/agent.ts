import type { AgentUsage, ModelBreakdown } from '../data-loader.ts';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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
import { deriveAgentRole } from '../agent-id.ts';
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
 * Priority: cached title > compaction summary > legacy summary.
 * Returns null when no title can be derived — caller shows UUID only.
 */
async function resolveSessionTitle(
	sessionId: string,
	project: string | undefined,
	claudePaths: string[],
): Promise<{ title: string; startTime: string } | { title: null; startTime: string } | null> {
	const cacheDir = path.join(os.homedir(), '.claude', 'session-titles');
	const cachePath = path.join(cacheDir, sessionId);

	// Check cache — versioned format: "v11\n<title>\n<startTime>"
	// v11: invalidate AI-generated title caches from v10
	const CACHE_VERSION = 'v11';
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

	let compactionTitle: string | null = null;
	let summaryTitle: string | null = null;
	let startTime: string | null = null;

	// Phase 1: quick scan of first 50 lines for startTime, userMessages, and early compaction
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

	// Only compaction/summary titles are deterministic — use directly
	const title = compactionTitle ?? summaryTitle;

	if (title != null && startTime != null) {
		try {
			await mkdir(cacheDir, { recursive: true });
			await writeFile(cachePath, `${CACHE_VERSION}\n${title}\n${startTime}`, 'utf-8');
		} catch {
			// Cache write failure is non-fatal
		}
		return { title, startTime };
	}

	// No title available — return startTime so caller can show UUID with timestamp
	if (startTime != null) {
		return { title: null, startTime };
	}

	return null;
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
 * Falls back to UUID-only display when no compaction summary exists.
 */
async function resolveLeadDisplayNames(agents: AgentUsage[], timezone?: string): Promise<void> {
	let claudePaths: string[] | null = null;

	for (let i = 0; i < agents.length; i++) {
		const agent = agents[i]!;
		if (!agent.agentId.startsWith('lead:') || agent.sessionId == null) {
			continue;
		}

		if (claudePaths == null) {
			try {
				claudePaths = getClaudePaths();
			} catch {
				claudePaths = [];
			}
		}

		const titleInfo = await resolveSessionTitle(agent.sessionId, agent.project, claudePaths);
		if (titleInfo == null) {
			// No data at all — show UUID only
			agent.agentId = agent.sessionId;
		} else if (titleInfo.title != null) {
			// Got a resolved title (cached, compaction, or summary)
			agent.agentId = `${titleInfo.title} · ${formatStartTime(titleInfo.startTime, timezone)} · ${agent.sessionId}`;
		} else {
			// No title — show UUID with timestamp
			agent.agentId = `${formatStartTime(titleInfo.startTime, timezone)} · ${agent.sessionId}`;
		}
	}
}

/**
 * Loads team configs from ~/.claude/teams/ to build a teamName → leadSessionId map.
 */
async function loadTeamLeadMap(claudePaths: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const cp of claudePaths) {
		const teamsDir = path.join(cp, 'teams');
		let entries: string[];
		try {
			entries = await readdir(teamsDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (map.has(entry)) {
				continue;
			}
			try {
				const raw = await readFile(path.join(teamsDir, entry, 'config.json'), 'utf-8');
				const config = JSON.parse(raw) as { leadSessionId?: string };
				if (typeof config.leadSessionId === 'string') {
					map.set(entry, config.leadSessionId);
				}
			} catch {
				// Skip invalid configs
			}
		}
	}
	return map;
}

/**
 * Reads the first few lines of a JSONL file to extract the teamName field.
 */
async function peekTeamName(filePath: string): Promise<string | null> {
	const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
	const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY });
	let lineCount = 0;
	let teamName: string | null = null;

	for await (const line of rl) {
		if (line.trim().length === 0) {
			continue;
		}
		lineCount++;
		if (lineCount > 5) {
			break;
		}

		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed.teamName === 'string') {
				teamName = parsed.teamName;
				break;
			}
		} catch {
			// skip unparseable lines
		}
	}

	rl.close();
	fileStream.destroy();
	return teamName;
}

/**
 * Discovers team→lead mappings for teams without configs by scanning subagent directories.
 * Files in {project}/{leadSessionId}/subagents/*.jsonl contain team member data
 * whose teamName may not have a ~/.claude/teams/ config entry.
 */
async function discoverOrphanTeams(
	displayData: AgentUsage[],
	teamLeadMap: Map<string, string>,
	claudePaths: string[],
): Promise<void> {
	// Find teams not in the config-based map
	const orphanTeams = new Set<string>();
	for (const d of displayData) {
		if (d.teamName != null && !teamLeadMap.has(d.teamName)) {
			orphanTeams.add(d.teamName);
		}
	}
	if (orphanTeams.size === 0) {
		return;
	}

	// Phase 0: Load cached team→lead mappings (survives JSONL compaction)
	const cacheDir = path.join(os.homedir(), '.claude', 'team-lead-cache');
	try {
		const cacheFiles = await readdir(cacheDir);
		for (const file of cacheFiles) {
			if (!orphanTeams.has(file)) {
				continue;
			}
			try {
				const leadSessionId = (await readFile(path.join(cacheDir, file), 'utf-8')).trim();
				if (leadSessionId !== '') {
					teamLeadMap.set(file, leadSessionId);
					orphanTeams.delete(file);
				}
			} catch {
				// skip unreadable cache entries
			}
		}
	} catch {
		// cache dir doesn't exist yet
	}
	if (orphanTeams.size === 0) {
		return;
	}

	const leads = displayData.filter(
		(d) => d.teamName == null && d.sessionId != null && d.project != null,
	);
	const newlyDiscovered = new Map<string, string>();

	// Phase 1: Scan subagent directories of known lead sessions
	for (const lead of leads) {
		if (orphanTeams.size === 0) {
			break;
		}
		for (const cp of claudePaths) {
			const subagentsDir = path.join(cp, 'projects', lead.project!, lead.sessionId!, 'subagents');
			let files: string[];
			try {
				files = await readdir(subagentsDir);
			} catch {
				continue;
			}

			for (const file of files) {
				if (!file.endsWith('.jsonl')) {
					continue;
				}
				const teamName = await peekTeamName(path.join(subagentsDir, file));
				if (teamName != null && orphanTeams.has(teamName) && !teamLeadMap.has(teamName)) {
					teamLeadMap.set(teamName, lead.sessionId!);
					newlyDiscovered.set(teamName, lead.sessionId!);
					orphanTeams.delete(teamName);
					if (orphanTeams.size === 0) {
						break;
					}
				}
			}
		}
	}

	if (orphanTeams.size > 0) {
		// Phase 2: Scan lead JSONL files for TeamCreate tool uses referencing orphan teams.
		// Some teams (e.g. spawned via TeamCreate) have no subagent files under the lead —
		// the only link is the TeamCreate tool_use entry in the lead's conversation.
		// After compaction, these entries are lost — that's why Phase 0 caches discoveries.
		for (const lead of leads) {
			if (orphanTeams.size === 0) {
				break;
			}
			for (const cp of claudePaths) {
				if (lead.project == null) {
					continue;
				}
				const jsonlPath = path.join(cp, 'projects', lead.project, `${lead.sessionId}.jsonl`);
				try {
					await stat(jsonlPath);
				} catch {
					continue;
				}

				const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
				const rl = createInterface({
					input: fileStream,
					crlfDelay: Number.POSITIVE_INFINITY,
				});

				for await (const line of rl) {
					// Cheap string check before JSON parse
					if (!line.includes('TeamCreate')) {
						continue;
					}

					try {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						if (parsed.type !== 'assistant') {
							continue;
						}
						const msg = parsed.message as Record<string, unknown> | undefined;
						const content = msg?.content;
						if (!Array.isArray(content)) {
							continue;
						}

						for (const block of content) {
							const b = block as Record<string, unknown>;
							if (b.type !== 'tool_use' || b.name !== 'TeamCreate') {
								continue;
							}
							const input = b.input as Record<string, unknown> | undefined;
							const tn = input?.team_name;
							if (typeof tn === 'string' && orphanTeams.has(tn) && !teamLeadMap.has(tn)) {
								teamLeadMap.set(tn, lead.sessionId!);
								newlyDiscovered.set(tn, lead.sessionId!);
								orphanTeams.delete(tn);
							}
						}
					} catch {
						// skip unparseable lines
					}

					if (orphanTeams.size === 0) {
						break;
					}
				}

				rl.close();
				fileStream.destroy();
			}
		}
	}

	// Persist newly discovered mappings so they survive JSONL compaction
	if (newlyDiscovered.size > 0) {
		try {
			await mkdir(cacheDir, { recursive: true });
			for (const [teamName, leadSessionId] of newlyDiscovered) {
				await writeFile(path.join(cacheDir, teamName), leadSessionId, 'utf-8');
			}
		} catch {
			// cache write failure is non-fatal
		}
	}
}

type DisplayRow = {
	data: AgentUsage;
	isLeadHeader: boolean; // header-only row for orphan leads (no usage data in current range)
	indent: boolean; // team member indented under lead
};

/**
 * Groups team members under their lead sessions using tree-style display.
 * Leads with members appear first (sorted by total group cost), then ungrouped entries.
 */
function groupByTeamLead(
	displayData: AgentUsage[],
	teamLeadMap: Map<string, string>,
	leadTitleCache: Map<string, string>,
): DisplayRow[] {
	// Map leadSessionId → lead entry (if present in data)
	const leadBySession = new Map<string, AgentUsage>();
	for (const d of displayData) {
		if (d.agentId.startsWith('lead:') || d.sessionId != null) {
			// After resolveLeadDisplayNames, leads no longer start with "lead:" —
			// they have resolved titles. Identify leads by having sessionId + no teamName.
			if (d.teamName == null && d.sessionId != null) {
				leadBySession.set(d.sessionId, d);
			}
		}
	}

	// Group team members under leads (by leadSessionId) or by teamName (when no config exists)
	const leadGroups = new Map<string, { lead: AgentUsage | null; members: AgentUsage[] }>();
	// Teams without a config — group by teamName directly
	const teamNameGroups = new Map<string, AgentUsage[]>();
	const ungrouped: AgentUsage[] = [];

	for (const d of displayData) {
		if (d.teamName != null && d.agentName != null) {
			// Team member — find its lead via config
			const leadSessionId = teamLeadMap.get(d.teamName);
			if (leadSessionId != null) {
				const group = leadGroups.get(leadSessionId);
				if (group != null) {
					group.members.push(d);
				} else {
					const lead = leadBySession.get(leadSessionId) ?? null;
					leadGroups.set(leadSessionId, { lead, members: [d] });
				}
			} else {
				// No config for this team — group by teamName
				const existing = teamNameGroups.get(d.teamName);
				if (existing != null) {
					existing.push(d);
				} else {
					teamNameGroups.set(d.teamName, [d]);
				}
			}
		} else if (d.teamName == null && d.sessionId != null) {
			// Lead entry — ensure group exists
			const existingGroup = leadGroups.get(d.sessionId);
			if (existingGroup != null) {
				existingGroup.lead = d;
			} else {
				leadGroups.set(d.sessionId, { lead: d, members: [] });
			}
		} else {
			ungrouped.push(d);
		}
	}

	// Build sorted output: groups by total cost (lead + members), then teamName groups, then ungrouped
	const sortedGroups = Array.from(leadGroups.entries())
		.map(([sessionId, group]) => {
			const leadCost = group.lead?.totalCost ?? 0;
			const memberCost = group.members.reduce((sum, m) => sum + m.totalCost, 0);
			return { sessionId, ...group, totalCost: leadCost + memberCost };
		})
		.sort((a, b) => b.totalCost - a.totalCost);

	const sortedTeamNameGroups = Array.from(teamNameGroups.entries())
		.map(([teamName, members]) => ({
			teamName,
			members,
			totalCost: members.reduce((sum, m) => sum + m.totalCost, 0),
		}))
		.sort((a, b) => b.totalCost - a.totalCost);

	const rows: DisplayRow[] = [];

	for (const group of sortedGroups) {
		if (group.lead != null) {
			rows.push({ data: group.lead, isLeadHeader: false, indent: false });
		} else {
			// Orphan lead — create header-only row from cached title
			const cachedTitle = leadTitleCache.get(group.sessionId);
			const title = cachedTitle != null ? `${cachedTitle} · ${group.sessionId}` : group.sessionId;
			rows.push({
				data: {
					agentId: title,
					agentName: undefined,
					teamName: undefined,
					sessionId: group.sessionId,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					modelsUsed: [],
					modelBreakdowns: [],
				},
				isLeadHeader: true,
				indent: false,
			});
		}
		// Sort members by cost descending
		group.members.sort((a, b) => b.totalCost - a.totalCost);
		for (const m of group.members) {
			rows.push({ data: m, isLeadHeader: false, indent: true });
		}
	}

	// Teams without configs — use teamName as header
	for (const group of sortedTeamNameGroups) {
		rows.push({
			data: {
				agentId: group.teamName,
				agentName: undefined,
				teamName: undefined,
				sessionId: undefined,
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				modelsUsed: [],
				modelBreakdowns: [],
			},
			isLeadHeader: true,
			indent: false,
		});
		group.members.sort((a, b) => b.totalCost - a.totalCost);
		for (const m of group.members) {
			rows.push({ data: m, isLeadHeader: false, indent: true });
		}
	}

	// Ungrouped entries (no team at all)
	ungrouped.sort((a, b) => b.totalCost - a.totalCost);
	for (const d of ungrouped) {
		rows.push({ data: d, isLeadHeader: false, indent: false });
	}

	return rows;
}

/**
 * Loads cached session titles for lead sessions (used for orphan lead headers).
 */
async function loadLeadTitleCache(teamLeadMap: Map<string, string>): Promise<Map<string, string>> {
	const cache = new Map<string, string>();
	const cacheDir = path.join(os.homedir(), '.claude', 'session-titles');
	for (const sessionId of new Set(teamLeadMap.values())) {
		try {
			const raw = await readFile(path.join(cacheDir, sessionId), 'utf-8');
			const lines = raw.trim().split('\n');
			if (lines.length >= 2 && lines[1] != null && lines[1] !== '') {
				cache.set(sessionId, lines[1]);
			}
		} catch {
			// No cached title
		}
	}
	return cache;
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

		// Group team members under their lead sessions
		let groupedRows: DisplayRow[] | null = null;
		if (!ctx.values.instances) {
			let claudePaths: string[];
			try {
				claudePaths = getClaudePaths();
			} catch {
				claudePaths = [];
			}
			const teamLeadMap = await loadTeamLeadMap(claudePaths);
			// Discover orphan teams (no config) by scanning subagent directories
			await discoverOrphanTeams(displayData, teamLeadMap, claudePaths);
			const leadTitleCache = await loadLeadTitleCache(teamLeadMap);
			groupedRows = groupByTeamLead(displayData, teamLeadMap, leadTitleCache);
		}

		// Calculate totals (from original data, not grouped rows which may include header-only rows)
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
				'%',
			];
			const compactHeaders = ['Agent', 'Models', 'Input', 'Output', 'Cost (USD)', '%'];
			const aligns: Array<'left' | 'right'> = [
				'left',
				'left',
				'right',
				'right',
				'right',
				'right',
				'right',
				'right',
				'right',
			];
			const compactAligns: Array<'left' | 'right'> = [
				'left',
				'left',
				'right',
				'right',
				'right',
				'right',
			];

			const table = new ResponsiveTable({
				head: headers,
				style: { head: ['cyan'] },
				colAligns: aligns,
				colWidthOverrides: { 0: 46 },
				compactHead: compactHeaders,
				compactColAligns: compactAligns,
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
			});

			const rows =
				groupedRows ?? displayData.map((d) => ({ data: d, isLeadHeader: false, indent: false }));

			for (const row of rows) {
				const { data, isLeadHeader, indent } = row;

				if (isLeadHeader) {
					// Orphan lead header — title only, no usage columns
					table.push([pc.dim(data.agentId), '', '', '', '', '', '', '', '']);
					continue;
				}

				const totalTokens =
					data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens;
				let displayName: string;
				if (indent) {
					// Team member — show just the agent name with tree prefix
					const name = data.agentName ?? data.agentId;
					displayName = `  └─ ${name}`;
				} else if (data.agentId.includes('/')) {
					// Ungrouped team/member — wrap at '/' boundary
					displayName = data.agentId.replace('/', '/\n');
				} else {
					displayName = data.agentId;
				}
				const pct = totals.totalCost > 0 ? (data.totalCost / totals.totalCost) * 100 : 0;
				const pctStr = pct < 0.1 ? '<0.1' : pct.toFixed(1);
				table.push([
					displayName,
					data.modelsUsed.length > 0 ? formatModelsDisplayMultiline(data.modelsUsed) : '',
					formatCompact(data.inputTokens),
					formatCompact(data.outputTokens),
					formatCompact(data.cacheCreationTokens),
					formatCompact(data.cacheReadTokens),
					formatCompact(totalTokens),
					formatCurrency(data.totalCost),
					pctStr,
				]);

				if (ctx.values.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns);
				}
			}

			addEmptySeparatorRow(table, 9);

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
				pc.yellow('100'),
			]);

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});
