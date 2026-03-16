/**
 * @fileoverview Utility for deriving human-readable agent IDs from usage data
 *
 * Produces IDs like "my-team/researcher-a1b2", "coder-c3d4", or "lead-e5f6"
 * based on the teamName, agentName, and sessionId fields in JSONL entries.
 *
 * @module agent-id
 */

type AgentEntry = {
	teamName?: string | undefined;
	agentName?: string | undefined;
	sessionId?: string | undefined;
};

/**
 * Derives a human-readable agent ID from a usage entry's metadata.
 *
 * - teamName + agentName + sessionId → `{teamName}/{agentName}-{sessionId[0:4]}`
 * - only agentName + sessionId → `{agentName}-{sessionId[0:4]}`
 * - neither (main agent) → `lead-{sessionId[0:4]}`
 * - no sessionId → just `lead`, `{agentName}`, or `{teamName}/{agentName}`
 */
export function deriveAgentId(entry: AgentEntry): string {
	const { teamName, agentName, sessionId } = entry;
	const suffix = sessionId != null ? `-${sessionId.slice(0, 4)}` : '';

	if (teamName != null && agentName != null) {
		return `${teamName}/${agentName}${suffix}`;
	}
	if (agentName != null) {
		return `${agentName}${suffix}`;
	}
	return `lead${suffix}`;
}

/**
 * Derives a role name (without session hash suffix) for grouping agent instances.
 *
 * - teamName + agentName → `{teamName}/{agentName}`
 * - only agentName → `{agentName}`
 * - neither → `lead`
 */
export function deriveAgentRole(entry: AgentEntry): string {
	const { teamName, agentName } = entry;

	if (teamName != null && agentName != null) {
		return `${teamName}/${agentName}`;
	}
	if (agentName != null) {
		return agentName;
	}
	return 'lead';
}

// Common parent/container directories that don't identify a specific project
const CONTAINER_DIRS = new Set([
	'IdeaProjects',
	'Projects',
	'projects',
	'repos',
	'Repos',
	'repositories',
	'src',
	'code',
	'Code',
	'workspace',
	'Workspace',
	'workspaces',
	'Documents',
	'Desktop',
	'Downloads',
	'dev',
	'Dev',
	'development',
]);

/**
 * Extracts a short human-readable project name from an encoded project path.
 * The encoded path uses '-' as a path separator (e.g. '-Users-thomas-IdeaProjects-diana').
 * Returns the last non-container segment, skipping generic directory names like 'IdeaProjects'.
 */
export function shortProjectName(encoded: string): string {
	const parts = encoded.split('-').filter(Boolean);
	for (let i = parts.length - 1; i >= 0; i--) {
		if (!CONTAINER_DIRS.has(parts[i]!)) {
			return parts[i]!;
		}
	}
	return parts.at(-1) ?? encoded;
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('deriveAgentRole', () => {
		it('returns teamName/agentName when both present', () => {
			expect(
				deriveAgentRole({
					teamName: 'ccusage-fork',
					agentName: 'researcher',
					sessionId: 'a1b2c3d4',
				}),
			).toBe('ccusage-fork/researcher');
		});

		it('returns agentName when no teamName', () => {
			expect(deriveAgentRole({ agentName: 'coder', sessionId: 'deadbeef' })).toBe('coder');
		});

		it('returns lead for main agent', () => {
			expect(deriveAgentRole({ sessionId: 'e5f6a7b8' })).toBe('lead');
		});

		it('returns lead when no fields present', () => {
			expect(deriveAgentRole({})).toBe('lead');
		});
	});

	describe('deriveAgentId', () => {
		it('returns teamName/agentName-sessionPrefix when all fields present', () => {
			expect(
				deriveAgentId({ teamName: 'ccusage-fork', agentName: 'researcher', sessionId: 'a1b2c3d4' }),
			).toBe('ccusage-fork/researcher-a1b2');
		});

		it('returns agentName-sessionPrefix when no teamName', () => {
			expect(deriveAgentId({ agentName: 'coder', sessionId: 'deadbeef' })).toBe('coder-dead');
		});

		it('returns lead-sessionPrefix for main agent (no teamName/agentName)', () => {
			expect(deriveAgentId({ sessionId: 'e5f6a7b8' })).toBe('lead-e5f6');
		});

		it('returns lead when no fields present', () => {
			expect(deriveAgentId({})).toBe('lead');
		});

		it('returns teamName/agentName without suffix when no sessionId', () => {
			expect(deriveAgentId({ teamName: 'my-team', agentName: 'worker' })).toBe('my-team/worker');
		});

		it('returns agentName without suffix when no sessionId or teamName', () => {
			expect(deriveAgentId({ agentName: 'solo' })).toBe('solo');
		});

		it('handles short sessionId gracefully', () => {
			expect(deriveAgentId({ sessionId: 'ab' })).toBe('lead-ab');
		});
	});

	describe('shortProjectName', () => {
		it('returns last segment for normal project path', () => {
			expect(shortProjectName('-Users-thomas-IdeaProjects-diana')).toBe('diana');
		});

		it('skips container directory IdeaProjects', () => {
			expect(shortProjectName('-Users-thomas-IdeaProjects')).toBe('thomas');
		});

		it('skips container directory Projects', () => {
			expect(shortProjectName('-Users-thomas-Projects')).toBe('thomas');
		});

		it('skips container directory Desktop', () => {
			expect(shortProjectName('-home-user-Desktop')).toBe('user');
		});

		it('returns last segment when not a container', () => {
			expect(shortProjectName('-Users-thomas-myapp')).toBe('myapp');
		});

		it('falls back to last segment when all are containers', () => {
			expect(shortProjectName('-Projects')).toBe('Projects');
		});

		it('returns encoded string for empty input', () => {
			expect(shortProjectName('')).toBe('');
		});
	});
}
