import type { TokenUsageEvent } from './_types.ts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
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
const KIMI_K2_6_MODEL = 'kimi-k2.6';
const KIMI_K2_6_EFFECTIVE_FROM_MS = Date.parse('2026-04-20T00:00:00.000Z');
const KIMI_CODE_ALIAS_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

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

function parseDefaultModelFromConfig(content: string): string | undefined {
	const match = /^default_model\s*=\s*"([^"]+)"\s*$/m.exec(content);
	const value = match?.[1];
	if (value == null) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function parseDefaultModelDisplayNameFromConfig(
	content: string,
	defaultModel: string,
): string | undefined {
	const header = `[models."${defaultModel}"]`;
	const headerIndex = content.indexOf(header);
	if (headerIndex === -1) {
		return undefined;
	}

	const bodyStart = headerIndex + header.length;
	const rest = content.slice(bodyStart);
	const nextHeaderMatch = /\n\[/.exec(rest);
	const body = nextHeaderMatch == null ? rest : rest.slice(0, nextHeaderMatch.index);
	const displayNameMatch = /^display_name\s*=\s*"([^"]+)"\s*$/m.exec(body);
	const value = displayNameMatch?.[1];
	if (value == null) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

export type DefaultModel = {
	model: string;
	displayName?: string;
	isFallback: boolean;
};

function normalizeModelSegment(model: string): string {
	const trimmed = model.trim();
	if (trimmed === '') {
		return 'unknown';
	}

	const idx = trimmed.lastIndexOf('/');
	const lastSegment = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
	return lastSegment.toLowerCase();
}

function isKimiK26Name(model: string | undefined): boolean {
	if (model == null) {
		return false;
	}

	const normalized = normalizeModelSegment(model);
	return normalized === KIMI_K2_6_MODEL || normalized === 'kimi-k2p6' || normalized === 'kimi-k2-6';
}

function shouldUseKimiK26ForAlias(timestamp: string): boolean {
	const timestampMs = Date.parse(timestamp);
	return !Number.isNaN(timestampMs) && timestampMs >= KIMI_K2_6_EFFECTIVE_FROM_MS;
}

function resolveEffectiveModel(defaultModel: DefaultModel, timestamp: string): string {
	if (defaultModel.isFallback) {
		return defaultModel.model;
	}

	if (isKimiK26Name(defaultModel.model)) {
		return KIMI_K2_6_MODEL;
	}

	const normalizedModel = normalizeModelSegment(defaultModel.model);
	if (
		KIMI_CODE_ALIAS_MODELS.has(normalizedModel) &&
		isKimiK26Name(defaultModel.displayName) &&
		shouldUseKimiK26ForAlias(timestamp)
	) {
		return KIMI_K2_6_MODEL;
	}

	return defaultModel.model;
}

async function loadDefaultModel(shareDir: string): Promise<DefaultModel> {
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
		const displayName = parseDefaultModelDisplayNameFromConfig(configResult.value, parsed);
		return {
			model: parsed,
			isFallback: false,
			...(displayName != null && { displayName }),
		};
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

async function processJSONLFileByLine(
	filePath: string,
	processLine: (line: string) => void | Promise<void>,
): Promise<void> {
	const fileStream = createReadStream(filePath, { encoding: 'utf8' });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed === '') {
			continue;
		}

		await processLine(trimmed);
	}
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

export type KimiWireFileReference = {
	file: string;
};

export type KimiTokenUsageLoadContext = {
	shareDir: string;
	sessionsDir: string;
	workDirLookup: Map<string, string>;
	defaultModel: DefaultModel;
};

type ReasoningBuffer = { content: string[]; lastFlushIndex: number };

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

export function resolveKimiShareDir(options: LoadOptions = {}): string {
	if (options.shareDir != null && options.shareDir.trim() !== '') {
		return path.resolve(options.shareDir);
	}

	const envPath = process.env[KIMI_SHARE_DIR_ENV]?.trim();
	return envPath != null && envPath !== '' ? path.resolve(envPath) : DEFAULT_KIMI_DIR;
}

export async function createKimiTokenUsageLoadContext(
	shareDir: string,
): Promise<{ context?: KimiTokenUsageLoadContext; missingDirectories: string[] }> {
	const sessionsDir = path.join(shareDir, KIMI_SESSIONS_DIR_NAME);
	const missingDirectories: string[] = [];

	const statResult = await Result.try({
		try: stat(sessionsDir),
		catch: (error) => error,
	});
	if (Result.isFailure(statResult) || !statResult.value.isDirectory()) {
		missingDirectories.push(sessionsDir);
		return { missingDirectories };
	}

	const workDirLookup = await loadWorkDirLookup(shareDir);
	const defaultModel = await loadDefaultModel(shareDir);

	return {
		context: {
			shareDir,
			sessionsDir,
			workDirLookup,
			defaultModel,
		},
		missingDirectories,
	};
}

export async function getKimiTokenUsageFiles(
	context: KimiTokenUsageLoadContext,
): Promise<KimiWireFileReference[]> {
	const files = await glob(SESSION_WIRE_GLOB, {
		cwd: context.sessionsDir,
		absolute: true,
	});

	return files.map((file) => ({ file }));
}

export function dedupeKimiTokenUsageEvents<T extends TokenUsageEvent>(events: T[]): T[] {
	const firstByKey = new Map<string, T>();

	for (const event of events) {
		const dedupeKey = event.dedupeKey;
		if (dedupeKey == null) {
			continue;
		}

		const existing = firstByKey.get(dedupeKey);
		if (
			existing == null ||
			new Date(event.timestamp).getTime() < new Date(existing.timestamp).getTime()
		) {
			firstByKey.set(dedupeKey, event);
		}
	}

	return events.filter((event) => {
		const dedupeKey = event.dedupeKey;
		return dedupeKey == null || firstByKey.get(dedupeKey) === event;
	});
}

export async function loadTokenUsageEventsFromWireFiles(
	files: KimiWireFileReference[],
	context: KimiTokenUsageLoadContext,
): Promise<TokenUsageEvent[]> {
	const events: TokenUsageEvent[] = [];
	const seenMessageIds = new Set<string>();

	// Accumulate reasoning content per (session + stream) that will be distributed to events.
	// Stream is either "main" or "subagent:{task_tool_call_id}" to avoid mixing reasoning across parallel subagents.
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

	for (const { file } of files) {
		const wireFileContext = resolveWireFileContext(
			context.sessionsDir,
			file,
			context.workDirLookup,
		);
		if (wireFileContext == null) {
			continue;
		}

		const sessionId = wireFileContext.sessionId;
		const baseStreamId = wireFileContext.streamId;

		const processResult = await Result.try({
			try: processJSONLFileByLine(file, async (trimmed) => {
				const parsedResult = Result.try({
					try: () => JSON.parse(trimmed) as unknown,
					catch: (error) => error,
				})();
				if (Result.isFailure(parsedResult)) {
					return;
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
					const dedupeKey =
						messageId == null ? undefined : `${sessionId}:${resolvedStreamId}:${messageId}`;
					let isDuplicate = false;
					if (dedupeKey != null) {
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

					let reasoningTokens = 0;
					const newContentCount = reasoningBuffer.content.length - reasoningBuffer.lastFlushIndex;
					if (newContentCount > 0) {
						const newContent = reasoningBuffer.content.slice(reasoningBuffer.lastFlushIndex);
						const reasoningText = newContent.join('\n');
						reasoningTokens = estimateTokensFromText(reasoningText);
						reasoningBuffer.lastFlushIndex = reasoningBuffer.content.length;
					}

					if (isDuplicate) {
						return;
					}

					reasoningTokens = Math.min(reasoningTokens, output);

					events.push({
						sessionId,
						timestamp,
						model: resolveEffectiveModel(context.defaultModel, timestamp),
						...(context.defaultModel.isFallback && { isFallbackModel: true }),
						...(dedupeKey != null && { dedupeKey }),
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
					return;
				}

				const update = v.safeParse(statusUpdateSchema, parsedResult.value);
				if (update.success) {
					processStatusUpdate(update.output, 'main');
					return;
				}

				const subagentEvent = v.safeParse(subagentEventSchema, parsedResult.value);
				if (!subagentEvent.success) {
					return;
				}

				const nestedEvent = subagentEvent.output.message.payload.event;
				if (nestedEvent == null) {
					return;
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
					return;
				}

				const subUpdate = v.safeParse(statusUpdateSchema, synthetic);
				if (subUpdate.success) {
					processStatusUpdate(subUpdate.output, streamId);
				}
			}),
			catch: (error) => error,
		});
		if (Result.isFailure(processResult)) {
			logger.debug('Failed to read Kimi session wire file', processResult.error);
			continue;
		}
	}

	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return events;
}

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const shareDir = resolveKimiShareDir(options);
	const { context, missingDirectories } = await createKimiTokenUsageLoadContext(shareDir);
	if (context == null) {
		return { events: [], missingDirectories };
	}

	const files = await getKimiTokenUsageFiles(context);
	const events = await loadTokenUsageEventsFromWireFiles(files, context);

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
			expect(event.model).toBe('kimi-code/kimi-for-coding');
			expect(event.inputTokens).toBe(17);
			expect(event.cachedInputTokens).toBe(5);
			expect(event.outputTokens).toBe(7);
			expect(event.totalTokens).toBe(24);
			expect(event.sessionId).toContain('abc123');
			expect(event.sessionId).toContain('session-1');
			expect(event.timestamp).toBe('2025-01-01T00:00:00.500Z');
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

		it('uses K2.6 model identity for kimi-for-coding entries after the K2.6 cutoff', async () => {
			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': [
						'default_model = "kimi-code/kimi-for-coding"',
						'',
						'[models."kimi-code/kimi-for-coding"]',
						'display_name = "Kimi-k2.6"',
						'',
					].join('\n'),
					sessions: {
						abc123: {
							'session-k26': {
								'wire.jsonl': JSON.stringify({
									timestamp: Date.parse('2026-04-20T00:00:00.000Z') / 1000,
									message: {
										type: 'StatusUpdate',
										payload: {
											message_id: 'msg-k26',
											token_usage: {
												input_other: 10,
												input_cache_read: 5,
												input_cache_creation: 2,
												output: 7,
											},
										},
									},
								}),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });

			expect(events).toHaveLength(1);
			expect(events[0]?.model).toBe('kimi-k2.6');
		});

		it('keeps kimi-for-coding on the configured alias before the K2.6 cutoff', async () => {
			await using fixture = await createFixture({
				'.kimi': {
					'config.toml': [
						'default_model = "kimi-code/kimi-for-coding"',
						'',
						'[models."kimi-code/kimi-for-coding"]',
						'display_name = "Kimi-k2.6"',
						'',
					].join('\n'),
					sessions: {
						abc123: {
							'session-k25': {
								'wire.jsonl': JSON.stringify({
									timestamp: Date.parse('2026-04-19T23:59:59.000Z') / 1000,
									message: {
										type: 'StatusUpdate',
										payload: {
											message_id: 'msg-k25',
											token_usage: {
												input_other: 10,
												input_cache_read: 5,
												input_cache_creation: 2,
												output: 7,
											},
										},
									},
								}),
							},
						},
					},
				},
			});

			const { events } = await loadTokenUsageEvents({ shareDir: fixture.getPath('.kimi') });

			expect(events).toHaveLength(1);
			expect(events[0]?.model).toBe('kimi-code/kimi-for-coding');
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
