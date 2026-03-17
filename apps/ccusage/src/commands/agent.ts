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
import spawn from 'nano-spawn';
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
 * Checks whether a title is valid (non-empty, not a bracketed placeholder like "[No content provided]").
 */
function isValidTitle(title: string): boolean {
	return title.length > 0 && !/^\[.*\]$/.test(title);
}

/**
 * Joins non-empty parts with ' · ' separator — prevents trailing/leading separators
 * when some parts are empty or undefined.
 */
function joinParts(parts: (string | undefined)[]): string {
	return parts.filter((p) => p != null && p !== '').join(' · ');
}

/**
 * Extracts a short descriptive title from a compaction summary text.
 * Compaction summaries are plain text starting with "This session is being continued..."
 * followed by "Summary:\n1. Primary Request and Intent:\n   - <description>".
 */
function extractCompactionSummary(text: string): string | null {
	// Look for "Primary Request and Intent:" section and grab the first content line after it
	const primaryMatch = text.match(/Primary Request and Intent[:\s]*\n(.+)/i);
	if (primaryMatch?.[1] != null) {
		const line = primaryMatch[1].replace(/^[-\s*]+/, '').trim();
		if (line.length > 0) {
			return line;
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
			return line;
		}
	}

	return null;
}

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';

/**
 * Reads Claude Code credentials from macOS Keychain (preferred) or file fallback.
 * Handles token refresh for expired OAuth tokens.
 */
async function getClaudeAuthHeaders(): Promise<Record<string, string> | null> {
	// Try ANTHROPIC_API_KEY first (API subscribers)
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (apiKey != null && apiKey !== '') {
		return {
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		};
	}

	// Read credentials: Keychain first, then file
	let creds: Record<string, unknown> | null = null;

	// macOS Keychain (has the freshest tokens)
	for (const service of ['Claude Code-credentials', 'Claude Code - credentials', 'Claude Code']) {
		try {
			const proc = await spawn('security', ['find-generic-password', '-s', service, '-w']);
			const raw = proc.stdout.trim();
			if (raw !== '') {
				creds = JSON.parse(raw) as Record<string, unknown>;
				break;
			}
		} catch {
			// Keychain entry not found
		}
	}

	// File fallback
	if (creds == null) {
		try {
			const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
			const raw = await readFile(credsPath, 'utf-8');
			creds = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// File not available
		}
	}

	if (creds == null) {
		return null;
	}

	const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
	if (oauth == null) {
		return null;
	}

	// Direct API key stored by Claude Code
	if (typeof oauth.apiKey === 'string' && oauth.apiKey !== '') {
		return {
			'x-api-key': oauth.apiKey,
			'anthropic-version': '2023-06-01',
		};
	}

	let accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
	const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
	const refreshToken = typeof oauth.refreshToken === 'string' ? oauth.refreshToken : null;

	// Refresh if expired or expiring within 5 minutes
	if (expiresAt > 0 && expiresAt / 1000 < Date.now() / 1000 + 300 && refreshToken != null) {
		try {
			const response = await fetch(OAUTH_REFRESH_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
					client_id: OAUTH_CLIENT_ID,
				}),
			});
			const res = response as unknown as { ok: boolean; json: () => Promise<unknown> };
			if (res.ok) {
				const data = (await res.json()) as { access_token?: string };
				if (typeof data.access_token === 'string') {
					accessToken = data.access_token;
				}
			}
		} catch {
			// Refresh failed — try with existing token anyway
		}
	}

	if (accessToken != null && accessToken !== '') {
		return {
			Authorization: `Bearer ${accessToken}`,
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'oauth-2025-04-20',
		};
	}

	return null;
}

/**
 * Generates AI titles for multiple sessions in a single API call.
 * Auth: Claude Code OAuth credentials > ANTHROPIC_API_KEY > claude CLI fallback.
 */
async function generateAITitlesBatch(
	sessions: Array<{ index: number; messages: string[] }>,
): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	if (sessions.length === 0) {
		return result;
	}

	const numbered = sessions.map((s) => `${s.index}. ${s.messages.join(' | ')}`).join('\n');

	const prompt = `Generate a short noun-phrase title (max 30 characters, 3-5 words) for each Claude Code session below. Focus on the task or goal. No verbs at the start, no "User asked to..." framing. Output ONLY numbered titles matching the input numbers, one per line.\n\n${numbered}`;

	let output: string | null = null;

	// Try direct API with OAuth/API key (no session pollution)
	const authHeaders = await getClaudeAuthHeaders();
	if (authHeaders != null) {
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...authHeaders,
				},
				body: JSON.stringify({
					model: 'claude-haiku-4-5-20251001',
					max_tokens: 1024,
					messages: [{ role: 'user', content: prompt }],
				}),
			});
			const res = response as unknown as { ok: boolean; json: () => Promise<unknown> };
			if (res.ok) {
				const data = (await res.json()) as { content?: Array<{ text?: string }> };
				output = data.content?.[0]?.text ?? null;
			}
		} catch {
			// API call failed — fall through to CLI
		}
	}

	// Fallback: claude CLI (creates a session entry but works without credentials file)
	if (output == null) {
		try {
			const proc = await spawn('claude', ['-p', prompt, '--model', 'haiku']);
			output = proc.stdout.trim();
		} catch {
			// CLI not available
		}
	}

	if (output != null) {
		for (const line of output.split('\n')) {
			const match = line.match(/^(\d+)\.\s*(.+)/);
			if (match != null) {
				const idx = Number.parseInt(match[1]!, 10);
				const title = match[2]!.trim();
				if (title.length > 0 && !/^\[.*\]$/.test(title)) {
					result.set(idx, title);
				}
			}
		}
	}

	return result;
}

/**
 * Resolves a session title from JSONL file content.
 * Priority: cached title > compaction summary (isCompactSummary user entry)
 * > legacy summary > AI-generated title > truncated sessionId (last resort).
 */
async function resolveSessionTitle(
	sessionId: string,
	project: string | undefined,
	claudePaths: string[],
): Promise<
	| { title: string; startTime: string }
	| { title: null; startTime: string; userMessages: string[] }
	| null
> {
	const cacheDir = path.join(os.homedir(), '.claude', 'session-titles');
	const cachePath = path.join(cacheDir, sessionId);

	// Check cache — versioned format: "v12\n<title>\n<startTime>"
	// v12: invalidate caches from v11 (filter bracketed AI placeholders)
	const CACHE_VERSION = 'v15';
	try {
		const cached = await readFile(cachePath, 'utf-8');
		const lines = cached.trim().split('\n');
		if (
			lines[0] === CACHE_VERSION &&
			lines.length >= 3 &&
			lines[1] != null &&
			lines[1] !== '' &&
			isValidTitle(lines[1]) &&
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

	let hasCompactionSummary = false;
	let summaryTitle: string | null = null;
	let userMessageTitle: string | null = null;
	const userMessages: string[] = [];
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
			// Check for compaction summary — feed to AI as high-quality input
			if (!hasCompactionSummary && parsed.type === 'user' && parsed.isCompactSummary === true) {
				const msg = parsed.message as Record<string, unknown> | undefined;
				if (msg?.role === 'user' && typeof msg.content === 'string') {
					const summary = extractCompactionSummary(msg.content);
					if (summary != null) {
						userMessages.unshift(summary);
						hasCompactionSummary = true;
					}
				}
			}
			if (summaryTitle == null && parsed.type === 'summary' && typeof parsed.summary === 'string') {
				summaryTitle = parsed.summary.slice(0, 60).trim();
			}
			if (parsed.type === 'user' && parsed.isCompactSummary !== true && parsed.isMeta !== true) {
				const msg = parsed.message as Record<string, unknown> | undefined;
				if (msg?.role === 'user') {
					const content = msg.content;
					// Extract text from string or array content (multimodal messages use [{type:"text",text:"..."}])
					let textContent: string | undefined;
					if (typeof content === 'string') {
						textContent = content;
					} else if (Array.isArray(content)) {
						const textBlock = content.find(
							(b: unknown) =>
								typeof b === 'object' &&
								b != null &&
								(b as Record<string, unknown>).type === 'text',
						) as Record<string, unknown> | undefined;
						if (typeof textBlock?.text === 'string') {
							textContent = textBlock.text;
						}
					}
					if (textContent != null) {
						// Extract inner text from <teammate-message> blocks
						if (/^<teammate-message\b/i.test(textContent)) {
							const innerMatch = textContent.match(
								/<teammate-message[^>]*>([\s\S]*?)<\/teammate-message>/i,
							);
							if (innerMatch?.[1] != null) {
								textContent = innerMatch[1].trim();
								// Strip "You are a ... on team ..." preamble
								textContent = textContent.replace(/^You are\b[^.]+\bon team [\w-]+\.\s*/i, '');
							} else {
								textContent = undefined;
							}
						} else if (/^<command-message\b/i.test(textContent)) {
							// Extract user's actual input from <command-args>
							const argsMatch = textContent.match(/<command-args>([\s\S]*?)<\/command-args>/i);
							if (argsMatch?.[1] != null) {
								textContent = argsMatch[1].trim();
							} else {
								textContent = undefined;
							}
						} else if (/^<[a-z]/i.test(textContent)) {
							// Skip other XML/HTML system content
							textContent = undefined;
						}
						if (textContent == null) {
							continue;
						}
						const firstLine = textContent.split('\n')[0]!.trim();
						if (firstLine.length > 0) {
							// Only set deterministic title from substantive messages
							if (firstLine.length >= 10 && firstLine.includes(' ') && userMessageTitle == null) {
								userMessageTitle = firstLine;
							}
							// Collect ALL non-empty messages for AI title generation
							if (userMessages.length < 3) {
								userMessages.push(truncateAtWord(firstLine, 120));
							}
						}
					}
				}
			}
		} catch {
			// Skip unparseable lines
		}
	}

	rl1.close();
	fileStream1.destroy();

	// Phase 2: if no compaction summary yet, fast-scan the whole file for isCompactSummary lines
	if (!hasCompactionSummary) {
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
						const summary = extractCompactionSummary(msg.content);
						if (summary != null) {
							userMessages.unshift(summary);
							hasCompactionSummary = true;
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

	// Legacy summary titles are deterministic — use directly
	// Filter out bracketed placeholders like "[No content provided]"
	if (summaryTitle != null && isValidTitle(summaryTitle) && startTime != null) {
		try {
			await mkdir(cacheDir, { recursive: true });
			await writeFile(cachePath, `${CACHE_VERSION}\n${summaryTitle}\n${startTime}`, 'utf-8');
		} catch {
			// Cache write failure is non-fatal
		}
		return { title: summaryTitle, startTime };
	}

	// No deterministic title — return messages for AI generation
	if (startTime != null && userMessages.length > 0) {
		return { title: null, startTime, userMessages };
	}

	// Absolute fallback: no user messages to generate from
	if (startTime != null) {
		return { title: null, startTime, userMessages: [] };
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
 * Falls back to project/lead-hash when title can't be derived.
 * Batches all AI title requests into a single API call.
 */
async function resolveLeadDisplayNames(agents: AgentUsage[], timezone?: string): Promise<void> {
	let claudePaths: string[] | null = null;
	const needsAI: Array<{
		agentIdx: number;
		startTime: string;
		messages: string[];
	}> = [];

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
			// No data at all — fallback to project/lead-hash
			const prefix = agent.project != null ? `${shortProjectName(agent.project)}/` : '';
			agent.agentId = `${prefix}${deriveAgentId({ sessionId: agent.sessionId })}`;
		} else if (titleInfo.title != null) {
			// Got a resolved title (cached, compaction, or user message)
			// Line 1: title · timestamp, Line 2: full UUID
			const line1 = joinParts([titleInfo.title, formatStartTime(titleInfo.startTime, timezone)]);
			agent.agentId = agent.sessionId != null ? `${line1}\n${agent.sessionId}` : line1;
		} else {
			// Needs AI title generation — collect for batch
			needsAI.push({
				agentIdx: i,
				startTime: titleInfo.startTime,
				messages: titleInfo.userMessages,
			});
		}
	}

	// Batch AI title generation in a single claude call
	if (needsAI.length > 0) {
		const batchInput = needsAI.map((item, idx) => ({ index: idx + 1, messages: item.messages }));
		const aiTitles = await generateAITitlesBatch(batchInput);

		const cacheDir = path.join(os.homedir(), '.claude', 'session-titles');
		const CACHE_VERSION = 'v15';

		for (const item of needsAI) {
			const agent = agents[item.agentIdx]!;
			const aiTitle = aiTitles.get(needsAI.indexOf(item) + 1);

			if (aiTitle != null) {
				// Line 1: title · timestamp, Line 2: full UUID
				const line1 = joinParts([aiTitle, formatStartTime(item.startTime, timezone)]);
				agent.agentId = agent.sessionId != null ? `${line1}\n${agent.sessionId}` : line1;

				// Cache only real AI-generated titles
				if (agent.sessionId != null) {
					try {
						await mkdir(cacheDir, { recursive: true });
						await writeFile(
							path.join(cacheDir, agent.sessionId),
							`${CACHE_VERSION}\n${aiTitle}\n${item.startTime}`,
							'utf-8',
						);
					} catch {
						// Cache write failure is non-fatal
					}
				}
			} else {
				// No AI title (no substantive messages) — show truncated ID + time + hint
				const shortId = agent.sessionId?.slice(0, 8) ?? 'Untitled';
				const firstMsg = item.messages[0];
				const hint =
					firstMsg != null
						? ` ("${firstMsg.length > 30 ? `${firstMsg.slice(0, 30)}…` : firstMsg}")`
						: '';
				const line1 = joinParts([shortId, formatStartTime(item.startTime, timezone)]) + hint;
				agent.agentId = agent.sessionId != null ? `${line1}\n${agent.sessionId}` : line1;
			}
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
	// Leads are identified by having sessionId set. They may have teamName set (team-aware leads)
	// or teamName null (standalone leads). Both are valid lead entries.
	const leadBySession = new Map<string, AgentUsage>();
	for (const d of displayData) {
		if (d.sessionId != null && d.agentName == null) {
			leadBySession.set(d.sessionId, d);
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
		} else if (d.sessionId != null && d.agentName == null) {
			// Lead entry (with or without teamName) — ensure group exists
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
	// Track sessionIds already emitted to prevent duplicate header rows
	const emittedSessionIds = new Set<string>();

	for (const group of sortedGroups) {
		if (emittedSessionIds.has(group.sessionId)) {
			// Already emitted — just add members under existing lead
			group.members.sort((a, b) => b.totalCost - a.totalCost);
			for (const m of group.members) {
				rows.push({ data: m, isLeadHeader: false, indent: true });
			}
			continue;
		}
		emittedSessionIds.add(group.sessionId);

		if (group.lead != null) {
			rows.push({ data: group.lead, isLeadHeader: false, indent: false });
		} else {
			// Orphan lead — create header-only row from cached title
			const cachedTitle = leadTitleCache.get(group.sessionId);
			const title = joinParts([cachedTitle, group.sessionId]);
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
			if (lines.length >= 2 && lines[1] != null && lines[1] !== '' && isValidTitle(lines[1])) {
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
