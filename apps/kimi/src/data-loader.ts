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
	SESSION_GLOB,
} from './_consts.ts';
import { logger } from './logger.ts';

const recordSchema = v.record(v.string(), v.unknown());

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
	const iso = date.toISOString();
	return iso === 'Invalid Date' ? null : iso;
}

export type LoadOptions = {
	shareDir?: string;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
};

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

	const files = await glob(SESSION_GLOB, {
		cwd: sessionsDir,
		absolute: true,
	});

	const events: TokenUsageEvent[] = [];
	const seenMessageIds = new Set<string>();

	// Accumulate reasoning content per session that will be distributed to events
	const sessionReasoningBuffers = new Map<string, { content: string[]; lastFlushIndex: number }>();

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

	for (const file of files) {
		if (!file.endsWith(`${path.sep}${KIMI_WIRE_FILE_NAME}`)) {
			continue;
		}

		const sessionDir = path.dirname(file);
		const sessionFileId = path.basename(sessionDir);
		const workDirBasename = path.basename(path.dirname(sessionDir));
		const resolvedWorkDir = workDirLookup.get(workDirBasename) ?? workDirBasename;
		const sessionId = `${resolvedWorkDir}/${sessionFileId}`;

		const fileContentResult = await Result.try({
			try: readFile(file, 'utf8'),
			catch: (error) => error,
		});
		if (Result.isFailure(fileContentResult)) {
			logger.debug('Failed to read Kimi session wire file', fileContentResult.error);
			continue;
		}

		const lines = fileContentResult.value.split(/\r?\n/);

		// Get or create reasoning buffer for this session
		let reasoningBuffer = sessionReasoningBuffers.get(sessionId);
		if (reasoningBuffer == null) {
			reasoningBuffer = { content: [], lastFlushIndex: 0 };
			sessionReasoningBuffers.set(sessionId, reasoningBuffer);
		}

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

			// Check if this is a ContentPart with thinking content (process inline)
			const contentPart = v.safeParse(contentPartSchema, parsedResult.value);
			if (contentPart.success) {
				if (contentPart.output.message.payload.type === 'think') {
					const thinkContent = contentPart.output.message.payload.think;
					if (thinkContent != null && thinkContent.trim() !== '') {
						reasoningBuffer.content.push(thinkContent);
					}
				}
				continue; // Move to next line
			}

			const update = v.safeParse(statusUpdateSchema, parsedResult.value);
			if (!update.success) {
				continue;
			}

			const payload = update.output.message.payload;
			if (payload == null) {
				continue;
			}

			const messageId = asNonEmptyString(payload.message_id);
			let isDuplicate = false;
			if (messageId != null) {
				const dedupeKey = `${sessionId}:${messageId}`;
				if (seenMessageIds.has(dedupeKey)) {
					isDuplicate = true;
				} else {
					seenMessageIds.add(dedupeKey);
				}
			}

			const tokenUsageRaw = payload.token_usage;
			const tokenUsage = v.safeParse(recordSchema, tokenUsageRaw);
			if (!tokenUsage.success) {
				continue;
			}

			const inputOther = ensureNumber(tokenUsage.output.input_other);
			const cacheRead = ensureNumber(tokenUsage.output.input_cache_read);
			const cacheCreation = ensureNumber(tokenUsage.output.input_cache_creation);
			const output = ensureNumber(tokenUsage.output.output);

			const inputTokens = inputOther + cacheRead + cacheCreation;
			const totalTokens = inputTokens + output;

			if (inputTokens === 0 && output === 0) {
				continue;
			}

			const timestamp = toIsoTimestamp(update.output.timestamp);
			if (timestamp == null) {
				continue;
			}

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
				continue;
			}

			// Ensure reasoning doesn't exceed total output for this event
			// (actual tokenization may differ from our 4-char estimate)
			reasoningTokens = Math.min(reasoningTokens, output);

			events.push({
				sessionId,
				timestamp,
				model: defaultModel.model,
				isFallbackModel: defaultModel.isFallback ? true : undefined,
				inputTokens,
				cachedInputTokens: cacheRead,
				outputTokens: output,
				reasoningOutputTokens: reasoningTokens,
				totalTokens,
			});
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
			expect(event.model).toBe('kimi-code/kimi-for-coding');
			expect(event.inputTokens).toBe(17);
			expect(event.cachedInputTokens).toBe(5);
			expect(event.outputTokens).toBe(7);
			expect(event.totalTokens).toBe(24);
			expect(event.sessionId).toContain('abc123');
			expect(event.sessionId).toContain('session-1');
			expect(event.timestamp).toBe('2025-01-01T00:00:00.500Z');
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

		it('extracts reasoning tokens from ContentPart think messages', async () => {
			// ~40 chars = ~10 tokens at 4 chars per token
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
