import type { TokenUsageEvent } from './_types.ts';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	DEFAULT_KIMI_DIR,
	KIMI_CONFIG_FILE_NAME,
	KIMI_METADATA_FILE_NAME,
	KIMI_MODEL_NAME_ENV,
	KIMI_SESSIONS_DIR_NAME,
	KIMI_SHARE_DIR_ENV,
	KIMI_WIRE_FILE_NAME,
	SESSION_WIRE_GLOB,
} from './_consts.ts';
import { logger } from './logger.ts';

const recordSchema = v.record(v.string(), v.unknown());

const KIMI_K2_6_RELEASE_TIMESTAMP = '2026-04-20T15:28:10.072Z';
const KIMI_K2_6_RELEASE_TIME_MS = Date.parse(KIMI_K2_6_RELEASE_TIMESTAMP);
const KIMI_CODE_LATEST_MODEL_ALIASES = new Set(['kimi-code', 'kimi-for-coding']);

// Estimate tokens from text content using ~4 chars per token heuristic
function estimateTokensFromText(text: string): number {
	return Math.ceil(text.length / 4);
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function ensureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function computeWorkDirBasename(workDir: string, kaos: string): string {
	const md5 = createHash('md5').update(workDir, 'utf8').digest('hex');
	return kaos === 'local' ? md5 : `${kaos}_${md5}`;
}

function normalizeModelAlias(model: string): string {
	const trimmed = model.trim();
	const idx = trimmed.lastIndexOf('/');
	const lastSegment = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
	return lastSegment.toLowerCase();
}

function resolveEffectiveModel(model: string, timestamp: string): string {
	if (!KIMI_CODE_LATEST_MODEL_ALIASES.has(normalizeModelAlias(model))) {
		return model;
	}

	const eventTimeMs = Date.parse(timestamp);
	if (!Number.isFinite(eventTimeMs)) {
		return model;
	}
	if (eventTimeMs < KIMI_K2_6_RELEASE_TIME_MS) {
		return 'kimi-k2.5';
	}

	// Kimi Code exposes only a stable latest-model alias in config/wire logs.
	// Use the official Kimi K2.6 release announcement time as the pricing cutoff:
	// https://x.com/Kimi_Moonshot/status/2046249571882500354
	return 'kimi-k2.6';
}

function parseDefaultModelFromConfig(content: string): string | undefined {
	const match = /^default_model\s*=\s*"([^"]+)"\s*$/m.exec(content);
	const value = match?.[1];
	if (value == null) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

async function loadDefaultModel(shareDir: string): Promise<{ model: string; isFallback: boolean }> {
	const envModel = asNonEmptyString(process.env[KIMI_MODEL_NAME_ENV]);
	if (envModel != null) {
		return { model: envModel, isFallback: false };
	}

	const configPath = path.join(shareDir, KIMI_CONFIG_FILE_NAME);
	const configResult = await Result.try({
		try: readFile(configPath, 'utf8'),
		catch: (error) => error,
	});
	if (Result.isFailure(configResult)) {
		return { model: 'unknown', isFallback: true };
	}

	const parsed = parseDefaultModelFromConfig(configResult.value);
	if (parsed != null) {
		return { model: parsed, isFallback: false };
	}

	return { model: 'unknown', isFallback: true };
}

type WorkDirEntry = {
	path: string;
	kaos?: string;
};

const metadataSchema = v.object({
	work_dirs: v.optional(v.array(v.object({ path: v.string(), kaos: v.optional(v.string()) }))),
});

async function loadWorkDirLookup(shareDir: string): Promise<Map<string, string>> {
	const lookup = new Map<string, string>();
	const metadataPath = path.join(shareDir, KIMI_METADATA_FILE_NAME);

	const metadataResult = await Result.try({
		try: readFile(metadataPath, 'utf8'),
		catch: (error) => error,
	});
	if (Result.isFailure(metadataResult)) {
		return lookup;
	}

	const parsed = Result.try({
		try: () => JSON.parse(metadataResult.value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(parsed)) {
		return lookup;
	}

	const validated = v.safeParse(metadataSchema, parsed.value);
	if (!validated.success) {
		return lookup;
	}

	const workDirs: WorkDirEntry[] = validated.output.work_dirs ?? [];
	for (const entry of workDirs) {
		const kaos = entry.kaos ?? 'local';
		const base = computeWorkDirBasename(entry.path, kaos);
		lookup.set(base, entry.path);
	}

	return lookup;
}

function toIsoTimestamp(seconds: number): string | null {
	const ms = seconds * 1000;
	if (!Number.isFinite(ms)) {
		return null;
	}
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toISOString();
}

export type LoadOptions = {
	shareDir?: string;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
};

function combineStreamId(parentStreamId: string, childStreamId: string): string {
	if (childStreamId === 'main') {
		return parentStreamId;
	}

	return parentStreamId === 'main' ? childStreamId : `${parentStreamId}/${childStreamId}`;
}

type WireFileContext = {
	sessionId: string;
	streamId: string;
};

function resolveWireFileContext(
	sessionsDir: string,
	file: string,
	workDirLookup: Map<string, string>,
): WireFileContext | null {
	const relativePath = path.relative(sessionsDir, file);
	const parts = relativePath.split(path.sep);
	if (parts.length < 3 || parts.at(-1) !== KIMI_WIRE_FILE_NAME) {
		return null;
	}

	const workDirBasename = parts[0];
	const sessionFileId = parts[1];
	if (workDirBasename == null || sessionFileId == null) {
		return null;
	}

	const resolvedWorkDir = workDirLookup.get(workDirBasename) ?? workDirBasename;
	const sessionId = `${resolvedWorkDir}/${sessionFileId}`;

	const nestedParts = parts.slice(2, -1);
	if (nestedParts.length === 0) {
		return { sessionId, streamId: 'main' };
	}

	if (nestedParts.length % 2 !== 0) {
		return null;
	}

	let streamId = 'main';
	for (let index = 0; index < nestedParts.length; index += 2) {
		if (nestedParts[index] !== 'subagents') {
			return null;
		}

		const agentId = asNonEmptyString(nestedParts[index + 1]);
		if (agentId == null) {
			return null;
		}

		streamId = combineStreamId(streamId, `subagent:${agentId}`);
	}

	return { sessionId, streamId };
}

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const shareDir =
		options.shareDir != null && options.shareDir.trim() !== ''
			? path.resolve(options.shareDir)
			: (() => {
					const envPath = process.env[KIMI_SHARE_DIR_ENV]?.trim();
					return envPath != null && envPath !== '' ? path.resolve(envPath) : DEFAULT_KIMI_DIR;
				})();

	const sessionsDir = path.join(shareDir, KIMI_SESSIONS_DIR_NAME);
	const missingDirectories: string[] = [];

	const statResult = await Result.try({
		try: stat(sessionsDir),
		catch: (error) => error,
	});
	if (Result.isFailure(statResult) || !statResult.value.isDirectory()) {
		missingDirectories.push(sessionsDir);
		return { events: [], missingDirectories };
	}

	const workDirLookup = await loadWorkDirLookup(shareDir);
	const defaultModel = await loadDefaultModel(shareDir);

	const files = await glob(SESSION_WIRE_GLOB, {
		cwd: sessionsDir,
		absolute: true,
	});

	const events: TokenUsageEvent[] = [];
	const seenMessageIds = new Set<string>();

	// Accumulate reasoning content per (session + stream) that will be distributed to events.
	// Stream is either "main" or "subagent:{task_tool_call_id}" to avoid mixing reasoning across parallel subagents.
	type ReasoningBuffer = { content: string[]; lastFlushIndex: number };
	const reasoningBuffers = new Map<string, ReasoningBuffer>();

	function getReasoningBuffer(sessionId: string, streamId: string): ReasoningBuffer {
		const key = `${sessionId}:${streamId}`;
		const existing = reasoningBuffers.get(key);
		if (existing != null) {
			return existing;
		}
		const created: ReasoningBuffer = { content: [], lastFlushIndex: 0 };
		reasoningBuffers.set(key, created);
		return created;
	}

	const statusUpdateSchema = v.object({
		timestamp: v.number(),
		message: v.object({
			type: v.literal('StatusUpdate'),
			payload: v.optional(recordSchema),
		}),
	});

	const contentPartSchema = v.object({
		timestamp: v.number(),
		message: v.object({
			type: v.literal('ContentPart'),
			payload: v.object({
				type: v.string(),
				think: v.optional(v.string()),
			}),
		}),
	});

	const subagentEventSchema = v.object({
		timestamp: v.number(),
		message: v.object({
			type: v.literal('SubagentEvent'),
			payload: v.object({
				task_tool_call_id: v.optional(v.string()),
				event: v.optional(
					v.object({
						type: v.string(),
						payload: v.optional(v.unknown()),
					}),
				),
			}),
		}),
	});

	for (const file of files) {
		const wireFileContext = resolveWireFileContext(sessionsDir, file, workDirLookup);
		if (wireFileContext == null) {
			continue;
		}

		const sessionId = wireFileContext.sessionId;
		const baseStreamId = wireFileContext.streamId;

		const fileContentResult = await Result.try({
			try: readFile(file, 'utf8'),
			catch: (error) => error,
		});
		if (Result.isFailure(fileContentResult)) {
			logger.debug('Failed to read Kimi session wire file', fileContentResult.error);
			continue;
		}

		const lines = fileContentResult.value.split(/\r?\n/);

		// Single pass: process lines in order, accumulating reasoning and attributing to StatusUpdates
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === '') {
				continue;
			}

			const parsedResult = Result.try({
				try: () => JSON.parse(trimmed) as unknown,
				catch: (error) => error,
			})();
			if (Result.isFailure(parsedResult)) {
				continue;
			}

			const processContentPart = (
				contentPart: v.InferOutput<typeof contentPartSchema>,
				streamId: string,
			) => {
				const resolvedStreamId = combineStreamId(baseStreamId, streamId);
				if (contentPart.message.payload.type !== 'think') {
					return;
				}
				const thinkContent = contentPart.message.payload.think;
				if (thinkContent == null || thinkContent.trim() === '') {
					return;
				}
				getReasoningBuffer(sessionId, resolvedStreamId).content.push(thinkContent);
			};

			const processStatusUpdate = (
				update: v.InferOutput<typeof statusUpdateSchema>,
				streamId: string,
			) => {
				const resolvedStreamId = combineStreamId(baseStreamId, streamId);
				const payload = update.message.payload;
				if (payload == null) {
					return;
				}

				const messageId = asNonEmptyString(payload.message_id);
				let isDuplicate = false;
				if (messageId != null) {
					const dedupeKey = `${sessionId}:${resolvedStreamId}:${messageId}`;
					if (seenMessageIds.has(dedupeKey)) {
						isDuplicate = true;
					} else {
						seenMessageIds.add(dedupeKey);
					}
				}

				const tokenUsageRaw = payload.token_usage;
				const tokenUsage = v.safeParse(recordSchema, tokenUsageRaw);
				if (!tokenUsage.success) {
					return;
				}

				const inputOther = ensureNumber(tokenUsage.output.input_other);
				const cacheRead = ensureNumber(tokenUsage.output.input_cache_read);
				const cacheCreation = ensureNumber(tokenUsage.output.input_cache_creation);
				const output = ensureNumber(tokenUsage.output.output);

				const inputTokens = inputOther + cacheRead + cacheCreation;
				const totalTokens = inputTokens + output;

				if (inputTokens === 0 && output === 0) {
					return;
				}

				const timestamp = toIsoTimestamp(update.timestamp);
				if (timestamp == null) {
					return;
				}

				const reasoningBuffer = getReasoningBuffer(sessionId, resolvedStreamId);

				// Calculate reasoning tokens from accumulated content since last StatusUpdate
				let reasoningTokens = 0;
				const newContentCount = reasoningBuffer.content.length - reasoningBuffer.lastFlushIndex;
				if (newContentCount > 0) {
					// Calculate tokens from new reasoning content since last event
					const newContent = reasoningBuffer.content.slice(reasoningBuffer.lastFlushIndex);
					const reasoningText = newContent.join('\n');
					reasoningTokens = estimateTokensFromText(reasoningText);

					// Update buffer position (even for duplicates to keep tracking accurate)
					reasoningBuffer.lastFlushIndex = reasoningBuffer.content.length;
				}

				// Skip duplicate events after capturing reasoning to avoid double-counting
				if (isDuplicate) {
					return;
				}

				// Ensure reasoning doesn't exceed total output for this event
				// (actual tokenization may differ from our 4-char estimate)
				reasoningTokens = Math.min(reasoningTokens, output);

				events.push({
					sessionId,
					timestamp,
					model: resolveEffectiveModel(defaultModel.model, timestamp),
					isFallbackModel: defaultModel.isFallback ? true : undefined,
					inputTokens,
					cachedInputTokens: cacheRead,
					outputTokens: output,
					reasoningOutputTokens: reasoningTokens,
					totalTokens,
				});
			};

			const contentPart = v.safeParse(contentPartSchema, parsedResult.value);
			if (contentPart.success) {
				processContentPart(contentPart.output, 'main');
				continue; // Move to next line
			}

			const update = v.safeParse(statusUpdateSchema, parsedResult.value);
			if (update.success) {
				processStatusUpdate(update.output, 'main');
				continue; // Move to next line
			}

			const subagentEvent = v.safeParse(subagentEventSchema, parsedResult.value);
			if (!subagentEvent.success) {
				continue;
			}

			const nestedEvent = subagentEvent.output.message.payload.event;
			if (nestedEvent == null) {
				continue;
			}

			const taskToolCallId =
				asNonEmptyString(subagentEvent.output.message.payload.task_tool_call_id) ?? 'unknown';
			const streamId = `subagent:${taskToolCallId}`;

			const synthetic = {
				timestamp: subagentEvent.output.timestamp,
				message: nestedEvent,
			};

			const subContentPart = v.safeParse(contentPartSchema, synthetic);
			if (subContentPart.success) {
				processContentPart(subContentPart.output, streamId);
				continue; // Move to next line
			}

			const subUpdate = v.safeParse(statusUpdateSchema, synthetic);
			if (subUpdate.success) {
				processStatusUpdate(subUpdate.output, streamId);
			}
		}
	}

	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadTokenUsageEvents', () => {
		it('parses StatusUpdate token_usage from wire.jsonl and maps token fields', async () => {
			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = \"kimi-code/kimi-for-coding\"\n',
					sessions: {
						abc123: {
							'session-1': {
								'wire.jsonl': [
									JSON.stringify({ type: 'metadata', protocol_version: '1.1' }),
									JSON.stringify({
										timestamp: 1735689600.5,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'msg-1',
												token_usage: {
													input_other: 10,
													input_cache_read: 5,
													input_cache_creation: 2,
													output: 7,
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events, missingDirectories } = await loadTokenUsageEvents({
				shareDir: fixture.getPath('.kimi'),
			});

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(1);
			const event = events[0]!;
			expect(event.model).toBe('kimi-k2.5');
			expect(event.inputTokens).toBe(17);
			expect(event.cachedInputTokens).toBe(5);
			expect(event.outputTokens).toBe(7);
			expect(event.totalTokens).toBe(24);
			expect(event.sessionId).toContain('abc123');
			expect(event.sessionId).toContain('session-1');
			expect(event.timestamp).toBe('2025-01-01T00:00:00.500Z');
		});

		it('resolves the Kimi Code latest-model alias across the official K2.6 release cutoff', async () => {
			const beforeReleaseSeconds = (KIMI_K2_6_RELEASE_TIME_MS - 1000) / 1000;
			const afterReleaseSeconds = KIMI_K2_6_RELEASE_TIME_MS / 1000;

			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = "kimi-code/kimi-for-coding"\n',
					sessions: {
						abc123: {
							'session-release-cutoff': {
								'wire.jsonl': [
									JSON.stringify({
										timestamp: beforeReleaseSeconds,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'before-release',
												token_usage: {
													input_other: 1,
													input_cache_read: 0,
													input_cache_creation: 0,
													output: 1,
												},
											},
										},
									}),
									JSON.stringify({
										timestamp: afterReleaseSeconds,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'after-release',
												token_usage: {
													input_other: 1,
													input_cache_read: 0,
													input_cache_creation: 0,
													output: 1,
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({
				shareDir: fixture.getPath('.kimi'),
			});

			expect(events).toHaveLength(2);
			expect(events[0]!.model).toBe('kimi-k2.5');
			expect(events[1]!.model).toBe('kimi-k2.6');
		});

		it('keeps explicit Kimi model IDs unchanged after the K2.6 cutoff', async () => {
			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = "kimi-k2.5"\n',
					sessions: {
						abc123: {
							'session-explicit-model': {
								'wire.jsonl': JSON.stringify({
									timestamp: KIMI_K2_6_RELEASE_TIME_MS / 1000,
									message: {
										type: 'StatusUpdate',
										payload: {
											message_id: 'explicit-model',
											token_usage: {
												input_other: 1,
												input_cache_read: 0,
												input_cache_creation: 0,
												output: 1,
											},
										},
									},
								}),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({
				shareDir: fixture.getPath('.kimi'),
			});

			expect(events).toHaveLength(1);
			expect(events[0]!.model).toBe('kimi-k2.5');
		});

		it('skips StatusUpdate entries with invalid timestamps', async () => {
			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = "kimi-code/kimi-for-coding"\n',
					sessions: {
						abc123: {
							'session-invalid-date': {
								'wire.jsonl': [
									JSON.stringify({
										timestamp: 1e20,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'invalid-date',
												token_usage: {
													input_other: 10,
													input_cache_read: 0,
													input_cache_creation: 0,
													output: 5,
												},
											},
										},
									}),
									JSON.stringify({
										timestamp: 1735689600,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'valid-date',
												token_usage: {
													input_other: 1,
													input_cache_read: 0,
													input_cache_creation: 0,
													output: 1,
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });

			expect(events).toHaveLength(1);
			expect(events[0]!.totalTokens).toBe(2);
		});

		it('parses StatusUpdate token_usage from SubagentEvent wrappers', async () => {
			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = \"kimi-code/kimi-for-coding\"\n',
					sessions: {
						abc123: {
							'session-4': {
								'wire.jsonl': [
									JSON.stringify({
										timestamp: 1735689600,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'main-1',
												token_usage: {
													input_other: 1,
													input_cache_read: 2,
													input_cache_creation: 3,
													output: 4,
												},
											},
										},
									}),
									JSON.stringify({
										timestamp: 1735689601,
										message: {
											type: 'SubagentEvent',
											payload: {
												task_tool_call_id: 'tool-1',
												event: {
													type: 'StatusUpdate',
													payload: {
														message_id: 'sub-1',
														token_usage: {
															input_other: 10,
															input_cache_read: 0,
															input_cache_creation: 0,
															output: 1,
														},
													},
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });
			expect(events).toHaveLength(2);
			expect(events.map((e) => e.totalTokens)).toEqual([10, 11]);
		});

		it('keeps reasoning attribution separate for main vs subagent streams', async () => {
			// 8 chars -> 2 tokens
			const subThinkContent = '12345678';
			const expectedReasoningTokens = Math.ceil(subThinkContent.length / 4);

			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = \"kimi-code/kimi-for-coding\"\n',
					sessions: {
						abc123: {
							'session-5': {
								'wire.jsonl': [
									// Subagent think content should not be attributed to main StatusUpdate
									JSON.stringify({
										timestamp: 1735689600,
										message: {
											type: 'SubagentEvent',
											payload: {
												task_tool_call_id: 'tool-2',
												event: {
													type: 'ContentPart',
													payload: {
														type: 'think',
														think: subThinkContent,
													},
												},
											},
										},
									}),
									// Main status update: should have 0 reasoning from subagent
									JSON.stringify({
										timestamp: 1735689601,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'main-1',
												token_usage: {
													input_other: 0,
													input_cache_read: 0,
													input_cache_creation: 0,
													output: 20,
												},
											},
										},
									}),
									// Subagent status update: should pick up its own reasoning
									JSON.stringify({
										timestamp: 1735689602,
										message: {
											type: 'SubagentEvent',
											payload: {
												task_tool_call_id: 'tool-2',
												event: {
													type: 'StatusUpdate',
													payload: {
														message_id: 'sub-1',
														token_usage: {
															input_other: 0,
															input_cache_read: 0,
															input_cache_creation: 0,
															output: 20,
														},
													},
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });
			expect(events).toHaveLength(2);
			expect(events[0]!.reasoningOutputTokens).toBe(0);
			expect(events[1]!.reasoningOutputTokens).toBe(expectedReasoningTokens);
		});

		it('maps work dir hashes back to their original paths and dedupes message_id entries', async () => {
			const workDir = '/tmp/project-a';
			const workDirBasename = computeWorkDirBasename(workDir, 'local');

			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = \"kimi-code/kimi-for-coding\"\n',
					'kimi.json': JSON.stringify({ work_dirs: [{ path: workDir, kaos: 'local' }] }),
					sessions: {
						[workDirBasename]: {
							'session-2': {
								'wire.jsonl': [
									JSON.stringify({
										timestamp: 1735689601,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'dup-1',
												token_usage: {
													input_other: 1,
													input_cache_read: 0,
													input_cache_creation: 0,
													output: 1,
												},
											},
										},
									}),
									JSON.stringify({
										timestamp: 1735689602,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'dup-1',
												token_usage: {
													input_other: 999,
													input_cache_read: 999,
													input_cache_creation: 999,
													output: 999,
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });
			expect(events).toHaveLength(1);
			expect(events[0]!.sessionId).toBe(`${workDir}/session-2`);
			expect(events[0]!.totalTokens).toBe(2);
		});

		it('includes subagent wire files under the parent session without cross-stream dedupe', async () => {
			const workDir = '/tmp/project-b';
			const workDirBasename = computeWorkDirBasename(workDir, 'local');

			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = "kimi-code/kimi-for-coding"\n',
					'kimi.json': JSON.stringify({ work_dirs: [{ path: workDir, kaos: 'local' }] }),
					sessions: {
						[workDirBasename]: {
							'session-6': {
								'wire.jsonl': JSON.stringify({
									timestamp: 1735689600,
									message: {
										type: 'StatusUpdate',
										payload: {
											message_id: 'shared-id',
											token_usage: {
												input_other: 10,
												input_cache_read: 5,
												input_cache_creation: 0,
												output: 3,
											},
										},
									},
								}),
								subagents: {
									'agent-1': {
										'wire.jsonl': [
											JSON.stringify({
												timestamp: 1735689601,
												message: {
													type: 'ContentPart',
													payload: {
														type: 'think',
														think: 'abcdefgh',
													},
												},
											}),
											JSON.stringify({
												timestamp: 1735689602,
												message: {
													type: 'StatusUpdate',
													payload: {
														message_id: 'shared-id',
														token_usage: {
															input_other: 20,
															input_cache_read: 1,
															input_cache_creation: 0,
															output: 5,
														},
													},
												},
											}),
										].join('\n'),
									},
								},
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });
			expect(events).toHaveLength(2);
			expect(events.every((event) => event.sessionId === `${workDir}/session-6`)).toBe(true);
			expect(events.map((event) => event.totalTokens)).toEqual([18, 26]);
			expect(events[1]!.reasoningOutputTokens).toBe(2);
		});

		it('extracts reasoning tokens from ContentPart think messages', async () => {
			// 65 chars = 17 tokens at 4 chars per token.
			const thinkContent = 'This is a test thinking process for the model to reason through.';
			const expectedReasoningTokens = Math.ceil(thinkContent.length / 4);

			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': 'default_model = "kimi-code/kimi-for-coding"\n',
					sessions: {
						abc123: {
							'session-3': {
								'wire.jsonl': [
									// ContentPart with think content comes first
									JSON.stringify({
										timestamp: 1735689600,
										message: {
											type: 'ContentPart',
											payload: {
												type: 'think',
												think: thinkContent,
											},
										},
									}),
									// StatusUpdate comes after with token usage
									JSON.stringify({
										timestamp: 1735689601,
										message: {
											type: 'StatusUpdate',
											payload: {
												message_id: 'msg-1',
												token_usage: {
													input_other: 10,
													input_cache_read: 5,
													input_cache_creation: 2,
													output: 20, // More than estimated reasoning tokens
												},
											},
										},
									}),
								].join('\n'),
							},
						},
					},
				},
			});

			const { events, missingDirectories } = await loadTokenUsageEvents({
				shareDir: fixture.getPath('.kimi'),
			});

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(1);
			const event = events[0]!;
			expect(event.reasoningOutputTokens).toBe(expectedReasoningTokens);
			expect(event.outputTokens).toBe(20);
			// Reasoning should be capped at output tokens
			expect(event.reasoningOutputTokens).toBeLessThanOrEqual(event.outputTokens);
		});
	});
}
