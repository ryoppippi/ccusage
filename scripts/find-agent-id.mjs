#!/usr/bin/env node

/**
 * find-agent-id.mjs
 *
 * Finds resumable agent IDs from Claude Code JSONL session files.
 * Supports two ID formats:
 *   - Team members (TeamCreate): "name@team" from teammate_spawned entries
 *   - Bare Agent subagents: hex IDs from agent_progress entries
 *
 * Usage:
 *   node scripts/find-agent-id.mjs --team ccusage-fork --agent implementer
 *   node scripts/find-agent-id.mjs --team ccusage-fork
 *   node scripts/find-agent-id.mjs --session dff4e7a9-f255-46f2-91f3-fc8f4c367118
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		team: { type: 'string', short: 't' },
		agent: { type: 'string', short: 'a' },
		session: { type: 'string', short: 's' },
		limit: { type: 'string', short: 'n', default: '20' },
		verbose: { type: 'boolean', short: 'v', default: false },
	},
});

if (!values.team && !values.agent && !values.session) {
	console.error('Usage: node find-agent-id.mjs --team <name> [--agent <name>] [--session <id>]');
	console.error('  -t, --team     Team name filter');
	console.error('  -a, --agent    Agent name filter');
	console.error('  -s, --session  Session ID to scan (instead of all files)');
	console.error('  -n, --limit    Max results (default: 20)');
	console.error('  -v, --verbose  Show source file paths');
	process.exit(1);
}

const limit = Number.parseInt(values.limit, 10) || 20;

/**
 * Try to find lead session file(s) from team config
 */
async function getTeamLeadFiles(teamName) {
	const configPath = join(homedir(), '.claude', 'teams', teamName, 'config.json');
	try {
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		const leadSessionId = config.leadSessionId;
		if (!leadSessionId) {
			return null;
		}

		return await findSessionFiles(leadSessionId);
	} catch {
		return null;
	}
}

/**
 * Find JSONL file(s) for a given session ID across all project dirs
 */
async function findSessionFiles(sessionId) {
	const bases = [
		join(homedir(), '.claude', 'projects'),
		join(homedir(), '.config', 'claude', 'projects'),
	];

	const files = [];
	for (const base of bases) {
		try {
			const projects = await readdir(base);
			for (const proj of projects) {
				const candidate = join(base, proj, `${sessionId}.jsonl`);
				try {
					await stat(candidate);
					files.push(candidate);
				} catch {
					// not found
				}
			}
		} catch {
			// base doesn't exist
		}
	}

	return files.length > 0 ? files : null;
}

/**
 * Collect ALL JSONL files from Claude project directories
 */
async function getAllJsonlFiles() {
	const bases = [
		join(homedir(), '.claude', 'projects'),
		join(homedir(), '.config', 'claude', 'projects'),
	];

	const files = [];
	for (const base of bases) {
		try {
			const projects = await readdir(base);
			for (const proj of projects) {
				const dir = join(base, proj);
				try {
					const s = await stat(dir);
					if (!s.isDirectory()) {
						continue;
					}
					const entries = await readdir(dir);
					for (const e of entries) {
						if (e.endsWith('.jsonl')) {
							files.push(join(dir, e));
						}
					}
				} catch {
					// skip
				}
			}
		} catch {
			// base doesn't exist
		}
	}
	return files;
}

/**
 * Scan a JSONL file for:
 * 1. teammate_spawned tool results (team members with name@team IDs)
 * 2. agent_progress entries (bare Agents with hex IDs)
 */
async function scanFile(filePath, teamFilter, agentFilter) {
	const results = [];
	const stream = createReadStream(filePath, { encoding: 'utf-8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });

	for await (const line of rl) {
		// Strategy 1: Find teammate_spawned entries (TeamCreate members)
		if (line.includes('teammate_spawned')) {
			try {
				const parsed = JSON.parse(line);
				const toolResult = parsed.toolUseResult;
				if (toolResult?.status !== 'teammate_spawned') {
					continue;
				}

				const agentId = toolResult.agent_id;
				const name = toolResult.name;
				const teamName = toolResult.team_name;
				if (!agentId) {
					continue;
				}

				// Apply filters
				if (teamFilter && teamName !== teamFilter) {
					continue;
				}
				if (agentFilter && name !== agentFilter) {
					continue;
				}

				results.push({
					timestamp: parsed.timestamp || 'unknown',
					agentId,
					label: `${teamName}/${name}`,
					type: 'team-member',
					model: toolResult.model,
					source: filePath,
				});
			} catch {
				// skip
			}
			continue;
		}

		// Strategy 2: Find agent_progress entries (bare Agent subagents)
		if (line.includes('"agent_progress"')) {
			// Fast string filter: if team/agent name provided, check line contains it
			if (teamFilter && !line.includes(teamFilter)) {
				continue;
			}
			if (agentFilter && !line.includes(agentFilter)) {
				continue;
			}

			try {
				const parsed = JSON.parse(line);
				if (parsed.type !== 'progress') {
					continue;
				}
				if (parsed.data?.type !== 'agent_progress') {
					continue;
				}

				const hexId = parsed.data.agentId;
				if (!hexId || typeof hexId !== 'string') {
					continue;
				}

				// Try to extract team/agent info from the nested message
				let nestedTeam = null;
				let nestedAgent = null;

				const msg = parsed.data.message;
				if (msg) {
					// The nested message may have teamName/agentName directly
					if (msg.teamName) {
						nestedTeam = msg.teamName;
					}
					if (msg.agentName) {
						nestedAgent = msg.agentName;
					}
				}

				// If we have a prompt, use it for the label
				const prompt = parsed.data.prompt;
				let label = 'bare-agent';
				if (nestedTeam && nestedAgent) {
					label = `${nestedTeam}/${nestedAgent}`;
				} else if (prompt) {
					// Extract first 40 chars of prompt as label
					label = `agent: ${prompt.slice(0, 40).replace(/\n/g, ' ')}...`;
				}

				// Strict filter: if team/agent specified, only include if nested data matches
				if (teamFilter && nestedTeam !== teamFilter) {
					continue;
				}
				if (agentFilter && nestedAgent !== agentFilter) {
					continue;
				}

				results.push({
					timestamp: parsed.timestamp || 'unknown',
					agentId: hexId,
					label,
					type: 'bare-agent',
					source: filePath,
				});
			} catch {
				// skip
			}
		}
	}

	rl.close();
	stream.destroy();
	return results;
}

async function main() {
	const { team: teamFilter, agent: agentFilter, session: sessionFilter } = values;

	// Determine which files to scan
	let files;

	if (sessionFilter) {
		// Scan specific session
		files = await findSessionFiles(sessionFilter);
		if (!files) {
			console.error(`Session file not found: ${sessionFilter}`);
			process.exit(1);
		}
		console.error(`Scanning session ${sessionFilter}`);
	} else if (teamFilter) {
		// Try lead session first (fast path)
		const leadFiles = await getTeamLeadFiles(teamFilter);
		if (leadFiles) {
			console.error(
				`Found lead session for team "${teamFilter}" — scanning ${leadFiles.length} file(s)`,
			);
			files = leadFiles;
		} else {
			console.error(`No team config for "${teamFilter}" — scanning all files`);
			files = await getAllJsonlFiles();
		}
	} else {
		console.error('Scanning all JSONL files...');
		files = await getAllJsonlFiles();
	}

	console.error(`Scanning ${files.length} file(s)...`);

	const allResults = [];
	for (const f of files) {
		const results = await scanFile(f, teamFilter, agentFilter);
		allResults.push(...results);
	}

	// Deduplicate by agentId, keep the EARLIEST timestamp per ID
	const byId = new Map();
	for (const r of allResults) {
		const existing = byId.get(r.agentId);
		if (!existing || r.timestamp < existing.timestamp) {
			byId.set(r.agentId, r);
		}
	}

	const unique = Array.from(byId.values());
	// Sort newest first
	unique.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

	if (unique.length === 0) {
		console.error('No matching entries found.');
		process.exit(1);
	}

	// Output
	const display = unique.slice(0, limit);
	for (const r of display) {
		const parts = [r.timestamp, r.label, r.agentId];
		if (r.type === 'team-member' && r.model) {
			parts.push(`(${r.model})`);
		}
		if (r.type === 'bare-agent') {
			parts.push('(bare-agent)');
		}
		if (values.verbose) {
			parts.push(r.source);
		}
		console.log(parts.join('  '));
	}

	console.error(`\n${display.length} result(s) shown (${unique.length} total)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
