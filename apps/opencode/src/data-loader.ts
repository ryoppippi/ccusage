import type { TokenUsageEvent } from './_types.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { DEFAULT_OPENCODE_DIR, OPENCODE_DATA_DIR_ENV } from './_consts.ts';
import { logger } from './logger.ts';

const tokensSchema = v.object({
	input: v.number(),
	output: v.number(),
	reasoning: v.number(),
	cache: v.object({
		read: v.number(),
		write: v.number(),
	}),
});

const assistantMessageSchema = v.object({
	id: v.string(),
	sessionID: v.string(),
	role: v.literal('assistant'),
	time: v.object({
		created: v.number(),
		completed: v.optional(v.number()),
	}),
	modelID: v.string(),
	providerID: v.string(),
	cost: v.number(),
	tokens: tokensSchema,
});

const sessionInfoSchema = v.object({
	id: v.string(),
	projectID: v.string(),
});

export type LoadOptions = {
	dataDir?: string;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectory: boolean;
};

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	const contentResult = await Result.try({
		try: readFile(filePath, 'utf8'),
		catch: error => error,
	});

	if (Result.isFailure(contentResult)) {
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(contentResult.value) as unknown,
		catch: error => error,
	});

	const parsed = parseResult();
	if (Result.isFailure(parsed)) {
		return null;
	}

	return parsed.value as T;
}

function getOpenCodeDataDir(): string {
	const envDir = process.env[OPENCODE_DATA_DIR_ENV]?.trim();
	if (envDir != null && envDir !== '') {
		return path.resolve(envDir);
	}
	return DEFAULT_OPENCODE_DIR;
}

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const dataDir = options.dataDir ?? getOpenCodeDataDir();
	const events: TokenUsageEvent[] = [];

	const dirStatResult = await Result.try({
		try: stat(dataDir),
		catch: error => error,
	});

	if (Result.isFailure(dirStatResult) || !dirStatResult.value.isDirectory()) {
		return { events: [], missingDirectory: true };
	}

	const projectFiles = await glob('project/*.json', {
		cwd: dataDir,
		absolute: true,
	});

	for (const projectFile of projectFiles) {
		const projectId = path.basename(projectFile, '.json');
		const sessionDir = path.join(dataDir, 'session', projectId);

		const sessionDirStatResult = await Result.try({
			try: stat(sessionDir),
			catch: error => error,
		});

		if (Result.isFailure(sessionDirStatResult) || !sessionDirStatResult.value.isDirectory()) {
			continue;
		}

		const sessionFiles = await glob('*.json', {
			cwd: sessionDir,
			absolute: true,
		});

		for (const sessionFile of sessionFiles) {
			const sessionData = await readJsonFile<unknown>(sessionFile);
			const sessionParse = v.safeParse(sessionInfoSchema, sessionData);
			if (!sessionParse.success) {
				logger.debug('Invalid session file', sessionFile);
				continue;
			}

			const sessionId = sessionParse.output.id;
			const messageDir = path.join(dataDir, 'message', sessionId);

			const messageDirStatResult = await Result.try({
				try: stat(messageDir),
				catch: error => error,
			});

			if (Result.isFailure(messageDirStatResult) || !messageDirStatResult.value.isDirectory()) {
				continue;
			}

			const messageFiles = await glob('*.json', {
				cwd: messageDir,
				absolute: true,
			});

			for (const messageFile of messageFiles) {
				const messageData = await readJsonFile<unknown>(messageFile);

				const messageParse = v.safeParse(assistantMessageSchema, messageData);
				if (!messageParse.success) {
					continue;
				}

				const msg = messageParse.output;
				const tokens = msg.tokens;

				const totalTokens = tokens.input + tokens.output + tokens.reasoning;

				const event: TokenUsageEvent = {
					timestamp: msg.time.completed ?? msg.time.created,
					sessionId: msg.sessionID,
					projectId,
					modelId: msg.modelID,
					providerId: msg.providerID,
					inputTokens: tokens.input,
					outputTokens: tokens.output,
					reasoningTokens: tokens.reasoning,
					cacheReadTokens: tokens.cache.read,
					cacheWriteTokens: tokens.cache.write,
					totalTokens,
					cost: msg.cost,
				};

				events.push(event);
			}
		}
	}

	events.sort((a, b) => a.timestamp - b.timestamp);

	return { events, missingDirectory: false };
}

if (import.meta.vitest != null) {
	describe('loadTokenUsageEvents', () => {
		it('loads events from OpenCode storage structure', async () => {
			await using fixture = await createFixture({
				project: {
					'test-project.json': JSON.stringify({
						id: 'test-project',
						vcs: 'git',
						worktree: '/test',
					}),
				},
				session: {
					'test-project': {
						'session-1.json': JSON.stringify({
							id: 'session-1',
							projectID: 'test-project',
						}),
					},
				},
				message: {
					'session-1': {
						'msg-1.json': JSON.stringify({
							id: 'msg-1',
							sessionID: 'session-1',
							role: 'assistant',
							time: { created: 1735600000000, completed: 1735600001000 },
							modelID: 'claude-sonnet-4-20250514',
							providerID: 'anthropic',
							cost: 0.05,
							tokens: {
								input: 1000,
								output: 500,
								reasoning: 0,
								cache: { read: 200, write: 100 },
							},
						}),
						'msg-2.json': JSON.stringify({
							id: 'msg-2',
							sessionID: 'session-1',
							role: 'user',
							time: { created: 1735600002000 },
						}),
					},
				},
			});

			const { events, missingDirectory } = await loadTokenUsageEvents({
				dataDir: fixture.path,
			});

			expect(missingDirectory).toBe(false);
			expect(events).toHaveLength(1);

			const event = events[0]!;
			expect(event.modelId).toBe('claude-sonnet-4-20250514');
			expect(event.providerId).toBe('anthropic');
			expect(event.inputTokens).toBe(1000);
			expect(event.outputTokens).toBe(500);
			expect(event.cacheReadTokens).toBe(200);
			expect(event.cacheWriteTokens).toBe(100);
			expect(event.cost).toBe(0.05);
		});

		it('returns empty events for missing directory', async () => {
			const { events, missingDirectory } = await loadTokenUsageEvents({
				dataDir: '/nonexistent/path',
			});

			expect(missingDirectory).toBe(true);
			expect(events).toHaveLength(0);
		});
	});
}
