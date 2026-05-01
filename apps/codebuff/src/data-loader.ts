/**
 * @fileoverview Data loading utilities for Codebuff CLI usage analysis.
 *
 * Codebuff (formerly Manicode) persists chat history under
 * `~/.config/manicode/projects/<projectBasename>/chats/<chatId>/`:
 *
 *   - `chat-messages.json`  – serialized ChatMessage[]; token/credit data lives
 *                             on `message.metadata` and (for provider-routed
 *                             calls) on the stashed RunState's message history.
 *   - `run-state.json`      – SDK RunState snapshot; we read `cwd` from it so
 *                             sessions can be grouped by the originating
 *                             project directory.
 *
 * Dev / staging channels use the same layout under `manicode-dev` /
 * `manicode-staging` roots, and the loader walks all three when present.
 *
 * @module data-loader
 */

import type { ChatMetadata, TokenUsageEvent } from './_types.ts';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	CODEBUFF_CHANNELS,
	CODEBUFF_CHAT_MESSAGES_FILE,
	CODEBUFF_CHATS_DIR_NAME,
	CODEBUFF_DATA_DIR_ENV,
	CODEBUFF_PROJECTS_DIR_NAME,
	CODEBUFF_RUN_STATE_FILE,
	DEFAULT_CODEBUFF_DIR,
} from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Codebuff stores per-assistant usage in several places depending on which
 * path the message took. We lean on valibot's permissive schemas because the
 * same key can show up in snake_case (OpenAI/OpenRouter) or camelCase
 * (Anthropic SDK, Codebuff's own builds).
 */
const usageSchema = v.object({
	inputTokens: v.optional(v.number()),
	input_tokens: v.optional(v.number()),
	promptTokens: v.optional(v.number()),
	prompt_tokens: v.optional(v.number()),
	outputTokens: v.optional(v.number()),
	output_tokens: v.optional(v.number()),
	completionTokens: v.optional(v.number()),
	completion_tokens: v.optional(v.number()),
	cacheCreationInputTokens: v.optional(v.number()),
	cache_creation_input_tokens: v.optional(v.number()),
	cachedTokensCreated: v.optional(v.number()),
	cached_tokens_created: v.optional(v.number()),
	cacheReadInputTokens: v.optional(v.number()),
	cache_read_input_tokens: v.optional(v.number()),
	promptTokensDetails: v.optional(
		v.object({
			cachedTokens: v.optional(v.number()),
		}),
	),
	prompt_tokens_details: v.optional(
		v.object({
			cached_tokens: v.optional(v.number()),
		}),
	),
});

type ParsedUsage = v.InferOutput<typeof usageSchema>;

const providerOptionsSchema = v.object({
	codebuff: v.optional(
		v.object({
			model: v.optional(v.string()),
			usage: v.optional(usageSchema),
		}),
	),
	usage: v.optional(usageSchema),
});

const historyMessageSchema = v.object({
	role: v.optional(v.string()),
	providerOptions: v.optional(providerOptionsSchema),
});

const runStateSchema = v.object({
	cwd: v.optional(v.string()),
	sessionState: v.optional(
		v.object({
			cwd: v.optional(v.string()),
			projectContext: v.optional(
				v.object({
					cwd: v.optional(v.string()),
				}),
			),
			fileContext: v.optional(
				v.object({
					cwd: v.optional(v.string()),
				}),
			),
			mainAgentState: v.optional(
				v.object({
					messageHistory: v.optional(v.array(historyMessageSchema)),
				}),
			),
		}),
	),
});

type ParsedRunState = v.InferOutput<typeof runStateSchema>;

const messageMetadataSchema = v.object({
	model: v.optional(v.string()),
	modelId: v.optional(v.string()),
	timestamp: v.optional(v.union([v.string(), v.number()])),
	codebuff: v.optional(
		v.object({
			model: v.optional(v.string()),
			usage: v.optional(usageSchema),
		}),
	),
	usage: v.optional(usageSchema),
	runState: v.optional(runStateSchema),
});

const chatMessageSchema = v.object({
	variant: v.optional(v.string()),
	role: v.optional(v.string()),
	content: v.optional(v.string()),
	credits: v.optional(v.number()),
	timestamp: v.optional(v.union([v.string(), v.number()])),
	createdAt: v.optional(v.union([v.string(), v.number()])),
	metadata: v.optional(messageMetadataSchema),
});

type ParsedChatMessage = v.InferOutput<typeof chatMessageSchema>;

function pickNumber(...vals: Array<number | undefined>): number | undefined {
	for (const candidate of vals) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function extractUsage(usage: ParsedUsage | undefined): {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
} {
	if (usage == null) {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
	}

	return {
		inputTokens:
			pickNumber(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens) ??
			0,
		outputTokens:
			pickNumber(
				usage.outputTokens,
				usage.output_tokens,
				usage.completionTokens,
				usage.completion_tokens,
			) ?? 0,
		cacheReadInputTokens:
			pickNumber(
				usage.cacheReadInputTokens,
				usage.cache_read_input_tokens,
				usage.promptTokensDetails?.cachedTokens,
				usage.prompt_tokens_details?.cached_tokens,
			) ?? 0,
		cacheCreationInputTokens:
			pickNumber(
				usage.cacheCreationInputTokens,
				usage.cache_creation_input_tokens,
				usage.cachedTokensCreated,
				usage.cached_tokens_created,
			) ?? 0,
	};
}

/**
 * Merge two usage extractions with per-field fallback: for each token class we
 * prefer the primary value when non-zero and fall through to the fallback
 * otherwise. This matters when the two sources are complementary — e.g.,
 * `metadata.usage` carries only input/output while `metadata.codebuff.usage`
 * is the only place cache tokens are recorded (or vice versa for the
 * RunState providerOptions fallback). An all-or-nothing merge would silently
 * drop the cache tokens in that case.
 */
function mergeUsageFallback(
	primary: ReturnType<typeof extractUsage>,
	fallback: ReturnType<typeof extractUsage>,
): ReturnType<typeof extractUsage> {
	return {
		inputTokens: primary.inputTokens > 0 ? primary.inputTokens : fallback.inputTokens,
		outputTokens: primary.outputTokens > 0 ? primary.outputTokens : fallback.outputTokens,
		cacheReadInputTokens:
			primary.cacheReadInputTokens > 0
				? primary.cacheReadInputTokens
				: fallback.cacheReadInputTokens,
		cacheCreationInputTokens:
			primary.cacheCreationInputTokens > 0
				? primary.cacheCreationInputTokens
				: fallback.cacheCreationInputTokens,
	};
}

/**
 * Extract model name + usage for a single assistant ChatMessage. Checks direct
 * metadata first then walks the stashed RunState history (where multi-provider
 * calls tend to record their OpenRouter-style totals).
 */
function extractAssistantUsage(msg: ParsedChatMessage): {
	model: string;
	credits: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
} {
	const meta = msg.metadata;
	let model: string | undefined = meta?.model ?? meta?.modelId ?? meta?.codebuff?.model;
	const credits = msg.credits ?? 0;

	const directUsage = mergeUsageFallback(
		extractUsage(meta?.usage),
		extractUsage(meta?.codebuff?.usage),
	);

	let providerUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
	};
	const history = meta?.runState?.sessionState?.mainAgentState?.messageHistory;
	if (Array.isArray(history)) {
		for (let i = history.length - 1; i >= 0; i--) {
			const entry = history[i];
			if (entry == null || entry.role !== 'assistant') {
				continue;
			}
			const providerOptions = entry.providerOptions;
			if (providerOptions == null) {
				continue;
			}
			const found = mergeUsageFallback(
				extractUsage(providerOptions.usage),
				extractUsage(providerOptions.codebuff?.usage),
			);
			if (
				found.inputTokens > 0 ||
				found.outputTokens > 0 ||
				found.cacheReadInputTokens > 0 ||
				found.cacheCreationInputTokens > 0
			) {
				providerUsage = found;
				if (model == null && providerOptions.codebuff?.model != null) {
					model = providerOptions.codebuff.model;
				}
				break;
			}
		}
	}

	const usage = mergeUsageFallback(directUsage, providerUsage);

	return {
		model: model ?? 'unknown',
		credits,
		...usage,
	};
}

/**
 * Reverse Codebuff's chatId → timestamp substitution (`:` replaced by `-` in
 * the time portion so the folder is filesystem-safe).
 */
function parseChatIdToIso(chatId: string): string | null {
	const iso = chatId.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3');
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function coerceTimestamp(value: string | number | undefined): string | null {
	if (value == null) {
		return null;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? new Date(value).toISOString() : null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function extractCwdFromRunState(runState: ParsedRunState | null): string | null {
	if (runState == null) {
		return null;
	}
	return (
		runState.sessionState?.projectContext?.cwd ??
		runState.sessionState?.fileContext?.cwd ??
		runState.sessionState?.cwd ??
		runState.cwd ??
		null
	);
}

/**
 * Resolve a user-supplied path, expanding a leading `~` or `~/` to the current
 * user's home directory before falling through to `path.resolve`. Node's
 * `path.resolve` does not expand `~` on its own, so docs examples like
 * `CODEBUFF_DATA_DIR=~/.config/manicode-dev` would otherwise resolve to
 * `<cwd>/~/.config/manicode-dev`.
 */
function resolveCodebuffPath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === '~') {
		return os.homedir();
	}
	if (trimmed.startsWith('~/')) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return path.resolve(trimmed);
}

export type CodebuffChannelRoot = { channel: string; root: string };

export type CodebuffChannelRootsResult = {
	roots: CodebuffChannelRoot[];
	/**
	 * An explicitly-set but invalid override (either the `baseDir` option or
	 * the `CODEBUFF_DATA_DIR` env var). Callers should surface this to the
	 * user so a typo'd path doesn't silently fall through to the default
	 * channels.
	 */
	invalidOverride: { source: 'baseDir' | 'env'; path: string } | null;
};

/**
 * Discover all Codebuff channel roots on disk (`~/.config/manicode`,
 * `-dev`, `-staging`). Honors `CODEBUFF_DATA_DIR` for a single custom root.
 *
 * When the explicit `customBaseDir` or `CODEBUFF_DATA_DIR` env var is set but
 * does not resolve to an existing directory, the invalid path is returned in
 * `invalidOverride` and a warning is logged so the mismatch is discoverable.
 */
export function getCodebuffChannelRoots(customBaseDir?: string): CodebuffChannelRootsResult {
	if (customBaseDir != null && customBaseDir.trim() !== '') {
		const normalized = resolveCodebuffPath(customBaseDir);
		if (isDirectorySync(normalized)) {
			const basename = path.basename(normalized);
			const channel = basename !== '' ? basename : 'manicode';
			return { roots: [{ channel, root: normalized }], invalidOverride: null };
		}
		logger.warn(
			`Codebuff baseDir "${customBaseDir}" is not a directory; no channel roots will be scanned.`,
		);
		return {
			roots: [],
			invalidOverride: { source: 'baseDir', path: normalized },
		};
	}

	const envPath = process.env[CODEBUFF_DATA_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalized = resolveCodebuffPath(envPath);
		if (isDirectorySync(normalized)) {
			const basename = path.basename(normalized);
			const channel = basename !== '' ? basename : 'manicode';
			return { roots: [{ channel, root: normalized }], invalidOverride: null };
		}
		logger.warn(
			`${CODEBUFF_DATA_DIR_ENV} is set to "${envPath}" but it is not a directory; falling back to default channels.`,
		);
		const roots: CodebuffChannelRoot[] = [];
		const configDir = path.dirname(DEFAULT_CODEBUFF_DIR);
		for (const channel of CODEBUFF_CHANNELS) {
			const root = path.join(configDir, channel);
			if (isDirectorySync(root)) {
				roots.push({ channel, root });
			}
		}
		return {
			roots,
			invalidOverride: { source: 'env', path: normalized },
		};
	}

	const roots: CodebuffChannelRoot[] = [];
	const configDir = path.dirname(DEFAULT_CODEBUFF_DIR);
	for (const channel of CODEBUFF_CHANNELS) {
		const root = path.join(configDir, channel);
		if (isDirectorySync(root)) {
			roots.push({ channel, root });
		}
	}
	return { roots, invalidOverride: null };
}

async function loadJsonFile<T>(
	filePath: string,
	schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
): Promise<T | null> {
	const readResult = await Result.try({
		try: readFile(filePath, 'utf-8'),
		catch: (error) => error,
	});

	if (Result.isFailure(readResult)) {
		logger.debug('Failed to read Codebuff JSON file', { filePath, error: readResult.error });
		return null;
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => error,
	})();

	if (Result.isFailure(parseResult)) {
		logger.debug('Failed to parse Codebuff JSON', { filePath, error: parseResult.error });
		return null;
	}

	const validation = v.safeParse(schema, parseResult.value);
	if (!validation.success) {
		logger.debug('Failed to validate Codebuff schema', {
			filePath,
			issues: validation.issues,
		});
		return null;
	}

	return validation.output;
}

export type LoadOptions = {
	/** Optional override for the Codebuff base directory. */
	baseDir?: string;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	chats: Map<string, ChatMetadata>;
	missingDirectories: string[];
};

/**
 * Load all Codebuff usage events from local chat-messages files.
 */
export async function loadCodebuffUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const { roots, invalidOverride } = getCodebuffChannelRoots(options.baseDir);

	const events: TokenUsageEvent[] = [];
	const chats = new Map<string, ChatMetadata>();
	const missingDirectories: string[] = [];

	// Surface an explicit-but-invalid override so callers see the typo'd path
	// rather than silently falling back to (or missing) the defaults.
	if (invalidOverride != null) {
		missingDirectories.push(invalidOverride.path);
	}

	if (roots.length === 0) {
		return { events, chats, missingDirectories };
	}

	for (const { channel, root } of roots) {
		const projectsDir = path.join(root, CODEBUFF_PROJECTS_DIR_NAME);
		if (!isDirectorySync(projectsDir)) {
			continue;
		}

		const chatDirs = await glob([`*/${CODEBUFF_CHATS_DIR_NAME}/*/`], {
			cwd: projectsDir,
			absolute: true,
			onlyDirectories: true,
		});

		for (const chatDir of chatDirs) {
			const chatId = path.basename(chatDir);
			const projectBasename = path.basename(path.dirname(path.dirname(chatDir)));
			const composedId = `${channel}::${projectBasename}::${chatId}`;

			const messages = await loadJsonFile(
				path.join(chatDir, CODEBUFF_CHAT_MESSAGES_FILE),
				v.array(chatMessageSchema),
			);
			if (messages == null || messages.length === 0) {
				continue;
			}

			const runState = await loadJsonFile(
				path.join(chatDir, CODEBUFF_RUN_STATE_FILE),
				runStateSchema,
			);

			const cwd = extractCwdFromRunState(runState);

			const firstUser = messages.find(
				(m) =>
					(m.variant ?? m.role) === 'user' && typeof m.content === 'string' && m.content.length > 0,
			);
			const rawTitle = (firstUser?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
			const title = rawTitle !== '' ? rawTitle : 'Untitled';

			const fallbackTs = parseChatIdToIso(chatId) ?? new Date(0).toISOString();
			let firstTs = fallbackTs;
			let lastTs = fallbackTs;
			let ingested = 0;

			for (const msg of messages) {
				// Track session bounds across *all* messages (user + assistant) so
				// chats that start or end with a user message still report accurate
				// firstTimestamp/lastTimestamp in their ChatMetadata.
				const messageTs =
					coerceTimestamp(msg.timestamp ?? msg.createdAt ?? msg.metadata?.timestamp) ?? fallbackTs;
				if (messageTs < firstTs) {
					firstTs = messageTs;
				}
				if (messageTs > lastTs) {
					lastTs = messageTs;
				}

				const variant = msg.variant ?? msg.role;
				if (variant !== 'ai' && variant !== 'agent' && variant !== 'assistant') {
					continue;
				}

				const {
					model,
					credits,
					inputTokens,
					outputTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
				} = extractAssistantUsage(msg);

				const hasAnySignal =
					inputTokens > 0 ||
					outputTokens > 0 ||
					cacheReadInputTokens > 0 ||
					cacheCreationInputTokens > 0 ||
					credits > 0;
				if (!hasAnySignal) {
					continue;
				}

				events.push({
					timestamp: messageTs,
					chatId: composedId,
					projectBasename,
					channel,
					model,
					credits,
					inputTokens,
					outputTokens,
					cacheCreationInputTokens,
					cacheReadInputTokens,
					totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
				});
				ingested += 1;
			}

			if (ingested === 0) {
				continue;
			}

			chats.set(composedId, {
				chatId: composedId,
				title,
				projectBasename,
				channel,
				cwd,
				firstTimestamp: firstTs,
				lastTimestamp: lastTs,
			});
		}
	}

	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, chats, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadCodebuffUsageEvents', () => {
		it('parses Codebuff chat-messages files and extracts usage events', async () => {
			const chatMessages = [
				{
					variant: 'user',
					content: 'Add a readme for Codebuff support',
					timestamp: '2025-12-14T09:59:58.000Z',
				},
				{
					variant: 'ai',
					content: 'Sure, here is the readme',
					timestamp: '2025-12-14T10:00:00.000Z',
					credits: 1.25,
					metadata: {
						model: 'claude-sonnet-4-20250514',
						usage: {
							inputTokens: 500,
							outputTokens: 200,
							cacheCreationInputTokens: 300,
							cacheReadInputTokens: 100,
						},
					},
				},
			];
			const runState = {
				sessionState: {
					projectContext: { cwd: '/Users/demo/repos/agentlytics' },
				},
			};

			await using fixture = await createFixture({
				manicode: {
					projects: {
						agentlytics: {
							chats: {
								'2025-12-14T10-00-00.000Z': {
									'chat-messages.json': JSON.stringify(chatMessages),
									'run-state.json': JSON.stringify(runState),
								},
							},
						},
					},
				},
			});

			const { events, chats, missingDirectories } = await loadCodebuffUsageEvents({
				baseDir: fixture.getPath('manicode'),
			});

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(1);

			const event = events[0]!;
			expect(event.model).toBe('claude-sonnet-4-20250514');
			expect(event.inputTokens).toBe(500);
			expect(event.outputTokens).toBe(200);
			expect(event.cacheCreationInputTokens).toBe(300);
			expect(event.cacheReadInputTokens).toBe(100);
			expect(event.credits).toBe(1.25);
			expect(event.totalTokens).toBe(1100);
			expect(event.projectBasename).toBe('agentlytics');

			const chatMeta = chats.get(event.chatId);
			expect(chatMeta?.title).toBe('Add a readme for Codebuff support');
			expect(chatMeta?.cwd).toBe('/Users/demo/repos/agentlytics');
		});

		it('falls back to provider-options usage in the stashed RunState history', async () => {
			const chatMessages = [
				{ variant: 'user', content: 'Hi' },
				{
					variant: 'ai',
					content: 'Hello',
					metadata: {
						runState: {
							sessionState: {
								mainAgentState: {
									messageHistory: [
										{ role: 'user' },
										{
											role: 'assistant',
											providerOptions: {
												codebuff: {
													model: 'openai/gpt-4o',
													usage: {
														prompt_tokens: 2000,
														completion_tokens: 800,
														prompt_tokens_details: { cached_tokens: 400 },
													},
												},
											},
										},
									],
								},
							},
						},
					},
				},
			];

			await using fixture = await createFixture({
				manicode: {
					projects: {
						sandbox: {
							chats: {
								'2025-12-20T12-00-00.000Z': {
									'chat-messages.json': JSON.stringify(chatMessages),
								},
							},
						},
					},
				},
			});

			const { events } = await loadCodebuffUsageEvents({
				baseDir: fixture.getPath('manicode'),
			});

			expect(events).toHaveLength(1);
			const event = events[0]!;
			expect(event.model).toBe('openai/gpt-4o');
			expect(event.inputTokens).toBe(2000);
			expect(event.outputTokens).toBe(800);
			expect(event.cacheReadInputTokens).toBe(400);
		});

		it('returns empty result and records missing directory for an invalid baseDir', async () => {
			const { events, chats, missingDirectories } = await loadCodebuffUsageEvents({
				baseDir: '/nonexistent/codebuff-path',
			});

			expect(events).toEqual([]);
			expect(chats.size).toBe(0);
			expect(missingDirectories).toContain(path.resolve('/nonexistent/codebuff-path'));
		});

		it('records CODEBUFF_DATA_DIR in missingDirectories when it points at a non-directory', async () => {
			const previous = process.env[CODEBUFF_DATA_DIR_ENV];
			process.env[CODEBUFF_DATA_DIR_ENV] = '/nonexistent/codebuff-env-override';
			try {
				const { invalidOverride } = getCodebuffChannelRoots();
				expect(invalidOverride).toEqual({
					source: 'env',
					path: path.resolve('/nonexistent/codebuff-env-override'),
				});
			} finally {
				if (previous == null) {
					delete process.env[CODEBUFF_DATA_DIR_ENV];
				} else {
					process.env[CODEBUFF_DATA_DIR_ENV] = previous;
				}
			}
		});

		it('expands a leading ~ in CODEBUFF_DATA_DIR before resolving', async () => {
			const previous = process.env[CODEBUFF_DATA_DIR_ENV];
			process.env[CODEBUFF_DATA_DIR_ENV] = '~/__codebuff_does_not_exist__';
			try {
				const { invalidOverride } = getCodebuffChannelRoots();
				const home = os.homedir();
				expect(invalidOverride).toEqual({
					source: 'env',
					path: path.join(home, '__codebuff_does_not_exist__'),
				});
				expect(invalidOverride?.path.startsWith(home)).toBe(true);
			} finally {
				if (previous == null) {
					delete process.env[CODEBUFF_DATA_DIR_ENV];
				} else {
					process.env[CODEBUFF_DATA_DIR_ENV] = previous;
				}
			}
		});

		it('skips malformed chat-messages files gracefully', async () => {
			await using fixture = await createFixture({
				manicode: {
					projects: {
						broken: {
							chats: {
								'2025-12-20T13-00-00.000Z': {
									'chat-messages.json': 'not-valid-json',
								},
							},
						},
					},
				},
			});

			const { events } = await loadCodebuffUsageEvents({
				baseDir: fixture.getPath('manicode'),
			});
			expect(events).toEqual([]);
		});
	});
}
