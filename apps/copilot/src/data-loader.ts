/**
 * @fileoverview Data loading utilities for GitHub Copilot CLI usage analysis
 *
 * This module provides functions for loading and parsing Copilot CLI usage data
 * from events.jsonl files stored in Copilot session-state directories.
 * Copilot CLI stores data in ~/.copilot/session-state/{sessionId}/events.jsonl
 *
 * Usage data is extracted from session.shutdown events, which contain
 * aggregated per-model token metrics for each session segment.
 *
 * @module data-loader
 */

import type { SessionMetadata, TokenUsageEvent } from './_types.ts';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import * as v from 'valibot';
import {
	COPILOT_CONFIG_DIR_ENV,
	DEFAULT_COPILOT_DIR,
	EVENTS_FILENAME,
	SESSION_STATE_DIR_NAME,
	WORKSPACE_FILENAME,
} from './_consts.ts';
import { logger } from './logger.ts';

/**
 * session.start event context schema
 */
const sessionStartContextSchema = v.object({
	cwd: v.string(),
	gitRoot: v.optional(v.string()),
	repository: v.optional(v.string()),
	branch: v.optional(v.string()),
});

/**
 * session.start event data schema
 */
const sessionStartDataSchema = v.object({
	sessionId: v.string(),
	version: v.number(),
	producer: v.string(),
	copilotVersion: v.string(),
	startTime: v.string(),
	selectedModel: v.optional(v.string()),
	context: v.optional(sessionStartContextSchema),
});

/**
 * Model metrics usage schema within session.shutdown
 */
const modelUsageSchema = v.object({
	inputTokens: v.optional(v.number(), 0),
	outputTokens: v.optional(v.number(), 0),
	cacheReadTokens: v.optional(v.number(), 0),
	cacheWriteTokens: v.optional(v.number(), 0),
});

/**
 * Model metrics requests schema within session.shutdown
 */
const modelRequestsSchema = v.object({
	count: v.optional(v.number(), 0),
	cost: v.optional(v.number(), 0),
});

/**
 * Per-model metrics schema within session.shutdown
 */
const modelMetricsEntrySchema = v.object({
	requests: v.optional(modelRequestsSchema),
	usage: v.optional(modelUsageSchema),
});

/**
 * session.shutdown event data schema
 */
const sessionShutdownDataSchema = v.object({
	shutdownType: v.optional(v.string()),
	totalPremiumRequests: v.optional(v.number()),
	totalApiDurationMs: v.optional(v.number()),
	currentModel: v.optional(v.string()),
	modelMetrics: v.optional(v.record(v.string(), modelMetricsEntrySchema)),
});

/**
 * Generic event wrapper schema (type discriminated)
 */
const eventSchema = v.object({
	id: v.string(),
	timestamp: v.string(),
	type: v.string(),
	data: v.optional(v.unknown()),
	parentId: v.optional(v.nullable(v.string())),
});

type ParsedEvent = v.InferOutput<typeof eventSchema>;

/**
 * Get Copilot data directory
 * @returns Path to Copilot data directory, or null if not found
 */
export function getCopilotPath(): string | null {
	const envPath = process.env[COPILOT_CONFIG_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			return normalizedPath;
		}
		// Env var is set but invalid — warn and don't fall through to default
		logger.warn(
			`${COPILOT_CONFIG_DIR_ENV} is set to "${envPath}" but the directory does not exist. Ignoring.`,
		);
		return null;
	}

	if (isDirectorySync(DEFAULT_COPILOT_DIR)) {
		return DEFAULT_COPILOT_DIR;
	}

	return null;
}

/**
 * Parse a single line of events.jsonl
 */
function parseEventLine(line: string): ParsedEvent | null {
	const trimmed = line.trim();
	if (trimmed === '') {
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(trimmed) as unknown,
		catch: (error) => error,
	})();

	if (Result.isFailure(parseResult)) {
		return null;
	}

	const validationResult = v.safeParse(eventSchema, parseResult.value);
	if (!validationResult.success) {
		return null;
	}

	return validationResult.output;
}

/**
 * Extract session metadata from a session.start event
 */
function extractSessionMetadata(sessionId: string, event: ParsedEvent): SessionMetadata | null {
	const dataResult = v.safeParse(sessionStartDataSchema, event.data);
	if (!dataResult.success) {
		return null;
	}

	const data = dataResult.output;
	return {
		sessionId,
		cwd: data.context?.cwd ?? '',
		gitRoot: data.context?.gitRoot,
		repository: data.context?.repository,
		branch: data.context?.branch,
		copilotVersion: data.copilotVersion,
		startTime: data.startTime,
	};
}

/**
 * Extract token usage events from a session.shutdown event
 */
function extractUsageEvents(sessionId: string, event: ParsedEvent): TokenUsageEvent[] {
	const dataResult = v.safeParse(sessionShutdownDataSchema, event.data);
	if (!dataResult.success) {
		return [];
	}

	const data = dataResult.output;
	const modelMetrics = data.modelMetrics;
	if (modelMetrics == null) {
		return [];
	}

	const events: TokenUsageEvent[] = [];

	for (const [model, metrics] of Object.entries(modelMetrics)) {
		const usage = metrics.usage;
		if (usage == null) {
			continue;
		}

		const inputTokens = usage.inputTokens;
		const outputTokens = usage.outputTokens;
		const cacheReadTokens = usage.cacheReadTokens;
		const cacheWriteTokens = usage.cacheWriteTokens;

		if (
			inputTokens === 0 &&
			outputTokens === 0 &&
			cacheReadTokens === 0 &&
			cacheWriteTokens === 0 &&
			(metrics.requests?.count ?? 0) === 0
		) {
			continue;
		}

		events.push({
			timestamp: event.timestamp,
			sessionId,
			model,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
			requestCount: metrics.requests?.count ?? 0,
			premiumRequestCost: metrics.requests?.cost ?? 0,
		});
	}

	return events;
}

/**
 * Parse workspace.yaml for session metadata (simple key: value format)
 */
async function parseWorkspaceYaml(
	sessionDir: string,
	sessionId: string,
): Promise<SessionMetadata | null> {
	const workspacePath = path.join(sessionDir, WORKSPACE_FILENAME);

	const readResult = await Result.try({
		try: readFile(workspacePath, 'utf-8'),
		catch: (error) => error,
	});

	if (Result.isFailure(readResult)) {
		return null;
	}

	const fields: Record<string, string> = {};
	for (const line of readResult.value.split('\n')) {
		const colonIndex = line.indexOf(':');
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim();
			const value = line.slice(colonIndex + 1).trim();
			fields[key] = value;
		}
	}

	return {
		sessionId,
		cwd: fields.cwd ?? '',
		gitRoot: fields.git_root,
		repository: fields.repository,
		branch: fields.branch,
		copilotVersion: '',
		startTime: fields.created_at ?? '',
	};
}

/**
 * Load events from a single session directory
 */
async function loadSessionEvents(
	sessionDir: string,
	sessionId: string,
): Promise<{ events: TokenUsageEvent[]; metadata: SessionMetadata | null }> {
	const eventsPath = path.join(sessionDir, EVENTS_FILENAME);

	const readResult = await Result.try({
		try: readFile(eventsPath, 'utf-8'),
		catch: (error) => error,
	});

	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read events file', { eventsPath, error: readResult.error });
		return { events: [], metadata: null };
	}

	const lines = readResult.value.split('\n');
	const events: TokenUsageEvent[] = [];
	let metadata: SessionMetadata | null = null;

	for (const line of lines) {
		const event = parseEventLine(line);
		if (event == null) {
			continue;
		}

		if (event.type === 'session.start' && metadata == null) {
			metadata = extractSessionMetadata(sessionId, event);
		} else if (event.type === 'session.shutdown') {
			const shutdownEvents = extractUsageEvents(sessionId, event);
			events.push(...shutdownEvents);
		}
	}

	// Enrich metadata from workspace.yaml (has repository/branch when session.start may not)
	const workspaceMetadata = await parseWorkspaceYaml(sessionDir, sessionId);
	if (workspaceMetadata != null) {
		if (metadata == null) {
			metadata = workspaceMetadata;
		} else {
			metadata.repository = metadata.repository ?? workspaceMetadata.repository;
			metadata.gitRoot = metadata.gitRoot ?? workspaceMetadata.gitRoot;
			metadata.branch = metadata.branch ?? workspaceMetadata.branch;
			if (metadata.cwd === '') {
				metadata.cwd = workspaceMetadata.cwd;
			}
		}
	}

	return { events, metadata };
}

export type LoadOptions = {
	sessionStateDirs?: string[];
};

export type LoadResult = {
	events: TokenUsageEvent[];
	sessions: Map<string, SessionMetadata>;
	missingDirectories: string[];
};

/**
 * Load all Copilot CLI usage events from session-state directories
 */
export async function loadCopilotUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const copilotPath = getCopilotPath();
	const providedDirs =
		options.sessionStateDirs != null && options.sessionStateDirs.length > 0
			? options.sessionStateDirs.map((dir) => path.resolve(dir))
			: undefined;

	const defaultSessionStateDir =
		copilotPath != null ? path.join(copilotPath, SESSION_STATE_DIR_NAME) : null;

	// When env var is set but invalid, report the expected session-state path as missing
	const envPath = process.env[COPILOT_CONFIG_DIR_ENV];
	const envSessionStateDir =
		envPath != null && envPath.trim() !== '' && copilotPath == null
			? path.join(path.resolve(envPath), SESSION_STATE_DIR_NAME)
			: null;

	const sessionStateDirs =
		providedDirs ??
		(defaultSessionStateDir != null
			? [defaultSessionStateDir]
			: envSessionStateDir != null
				? [envSessionStateDir]
				: []);

	const events: TokenUsageEvent[] = [];
	const sessions = new Map<string, SessionMetadata>();
	const missingDirectories: string[] = [];

	for (const dir of sessionStateDirs) {
		if (!isDirectorySync(dir)) {
			missingDirectories.push(dir);
			continue;
		}

		const readResult = await Result.try({
			try: readdir(dir),
			catch: (error) => error,
		});

		if (Result.isFailure(readResult)) {
			logger.debug('Failed to read session-state directory', { dir, error: readResult.error });
			continue;
		}

		const entries = readResult.value;

		for (const entry of entries) {
			const sessionDir = path.join(dir, entry);
			if (!isDirectorySync(sessionDir)) {
				continue;
			}

			const { events: sessionEvents, metadata } = await loadSessionEvents(sessionDir, entry);

			if (metadata != null) {
				sessions.set(entry, metadata);
			}

			events.push(...sessionEvents);
		}
	}

	// Sort events by timestamp
	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, sessions, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadCopilotUsageEvents', () => {
		it('parses events.jsonl and extracts usage events from session.shutdown', async () => {
			const eventsContent = [
				JSON.stringify({
					id: 'evt-1',
					timestamp: '2026-03-15T10:00:00.000Z',
					type: 'session.start',
					parentId: null,
					data: {
						sessionId: 'test-session-001',
						version: 1,
						producer: 'copilot-agent',
						copilotVersion: '1.0.0',
						startTime: '2026-03-15T10:00:00.000Z',
						context: {
							cwd: '/home/user/project',
							gitRoot: '/home/user/project',
							repository: 'user/project',
							branch: 'main',
						},
					},
				}),
				JSON.stringify({
					id: 'evt-2',
					timestamp: '2026-03-15T11:00:00.000Z',
					type: 'session.shutdown',
					parentId: 'evt-1',
					data: {
						shutdownType: 'routine',
						totalPremiumRequests: 5,
						totalApiDurationMs: 30000,
						currentModel: 'claude-opus-4.6-1m',
						modelMetrics: {
							'claude-opus-4.6-1m': {
								requests: { count: 3, cost: 5 },
								usage: {
									inputTokens: 10000,
									outputTokens: 500,
									cacheReadTokens: 8000,
									cacheWriteTokens: 0,
								},
							},
							'claude-sonnet-4.5': {
								requests: { count: 2, cost: 0 },
								usage: {
									inputTokens: 5000,
									outputTokens: 200,
									cacheReadTokens: 3000,
									cacheWriteTokens: 0,
								},
							},
						},
					},
				}),
			].join('\n');

			await using fixture = await createFixture({
				'session-state': {
					'test-session-001': {
						'events.jsonl': eventsContent,
					},
				},
			});

			const { events, sessions, missingDirectories } = await loadCopilotUsageEvents({
				sessionStateDirs: [fixture.getPath('session-state')],
			});

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(2);

			const opusEvent = events.find((e) => e.model === 'claude-opus-4.6-1m')!;
			expect(opusEvent.sessionId).toBe('test-session-001');
			expect(opusEvent.inputTokens).toBe(10000);
			expect(opusEvent.outputTokens).toBe(500);
			expect(opusEvent.cacheReadTokens).toBe(8000);
			expect(opusEvent.requestCount).toBe(3);
			expect(opusEvent.premiumRequestCost).toBe(5);

			const sonnetEvent = events.find((e) => e.model === 'claude-sonnet-4.5')!;
			expect(sonnetEvent.inputTokens).toBe(5000);
			expect(sonnetEvent.outputTokens).toBe(200);
			expect(sonnetEvent.cacheReadTokens).toBe(3000);

			const session = sessions.get('test-session-001')!;
			expect(session.repository).toBe('user/project');
			expect(session.cwd).toBe('/home/user/project');
			expect(session.copilotVersion).toBe('1.0.0');
		});

		it('handles missing directories gracefully', async () => {
			const { events, missingDirectories } = await loadCopilotUsageEvents({
				sessionStateDirs: ['/nonexistent/path'],
			});

			expect(events).toEqual([]);
			expect(missingDirectories).toContain(path.resolve('/nonexistent/path'));
		});

		it('handles malformed JSONL gracefully', async () => {
			await using fixture = await createFixture({
				'session-state': {
					'bad-session': {
						'events.jsonl': 'not valid json\n{also bad\n',
					},
				},
			});

			const { events } = await loadCopilotUsageEvents({
				sessionStateDirs: [fixture.getPath('session-state')],
			});

			expect(events).toEqual([]);
		});

		it('handles sessions with empty modelMetrics', async () => {
			const eventsContent = [
				JSON.stringify({
					id: 'evt-1',
					timestamp: '2026-03-15T10:00:00.000Z',
					type: 'session.start',
					parentId: null,
					data: {
						sessionId: 'empty-session',
						version: 1,
						producer: 'copilot-agent',
						copilotVersion: '1.0.0',
						startTime: '2026-03-15T10:00:00.000Z',
					},
				}),
				JSON.stringify({
					id: 'evt-2',
					timestamp: '2026-03-15T10:01:00.000Z',
					type: 'session.shutdown',
					parentId: 'evt-1',
					data: {
						shutdownType: 'routine',
						totalPremiumRequests: 0,
						totalApiDurationMs: 0,
						currentModel: 'claude-opus-4.6-1m',
						modelMetrics: {},
					},
				}),
			].join('\n');

			await using fixture = await createFixture({
				'session-state': {
					'empty-session': {
						'events.jsonl': eventsContent,
					},
				},
			});

			const { events, sessions } = await loadCopilotUsageEvents({
				sessionStateDirs: [fixture.getPath('session-state')],
			});

			expect(events).toEqual([]);
			expect(sessions.get('empty-session')).toBeDefined();
		});

		it('handles multiple shutdowns in one session (resume/shutdown cycles)', async () => {
			const eventsContent = [
				JSON.stringify({
					id: 'evt-1',
					timestamp: '2026-03-15T10:00:00.000Z',
					type: 'session.start',
					parentId: null,
					data: {
						sessionId: 'multi-shutdown',
						version: 1,
						producer: 'copilot-agent',
						copilotVersion: '1.0.0',
						startTime: '2026-03-15T10:00:00.000Z',
						context: { cwd: '/home/user/project' },
					},
				}),
				JSON.stringify({
					id: 'evt-2',
					timestamp: '2026-03-15T12:00:00.000Z',
					type: 'session.shutdown',
					parentId: 'evt-1',
					data: {
						shutdownType: 'routine',
						modelMetrics: {
							'claude-opus-4.6-1m': {
								requests: { count: 5, cost: 3 },
								usage: {
									inputTokens: 20000,
									outputTokens: 1000,
									cacheReadTokens: 15000,
									cacheWriteTokens: 0,
								},
							},
						},
					},
				}),
				JSON.stringify({
					id: 'evt-3',
					timestamp: '2026-03-16T09:00:00.000Z',
					type: 'session.shutdown',
					parentId: 'evt-1',
					data: {
						shutdownType: 'routine',
						modelMetrics: {
							'gpt-5.4': {
								requests: { count: 2, cost: 0 },
								usage: {
									inputTokens: 8000,
									outputTokens: 400,
									cacheReadTokens: 5000,
									cacheWriteTokens: 0,
								},
							},
						},
					},
				}),
			].join('\n');

			await using fixture = await createFixture({
				'session-state': {
					'multi-shutdown': {
						'events.jsonl': eventsContent,
					},
				},
			});

			const { events } = await loadCopilotUsageEvents({
				sessionStateDirs: [fixture.getPath('session-state')],
			});

			expect(events).toHaveLength(2);

			// First shutdown on March 15
			const firstEvent = events[0]!;
			expect(firstEvent.model).toBe('claude-opus-4.6-1m');
			expect(firstEvent.timestamp).toBe('2026-03-15T12:00:00.000Z');
			expect(firstEvent.inputTokens).toBe(20000);

			// Second shutdown on March 16
			const secondEvent = events[1]!;
			expect(secondEvent.model).toBe('gpt-5.4');
			expect(secondEvent.timestamp).toBe('2026-03-16T09:00:00.000Z');
			expect(secondEvent.inputTokens).toBe(8000);
		});
	});
}
