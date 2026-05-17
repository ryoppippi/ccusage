import type { QwenUsageEntry } from './types.ts';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { processJSONLFileByMarkers } from '@ccusage/internal/jsonl';
import { getDefaultWorkerThreadCount, mapWithConcurrency } from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { discoverQwenChatFiles } from './paths.ts';

const QWEN_JSONL_MARKERS = ['"usageMetadata"'];
const DEFAULT_QWEN_MODEL = 'unknown';
const DEFAULT_QWEN_PROVIDER = 'qwen';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function toNonNegativeInteger(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(Math.trunc(value), 0);
}

function parseTimestamp(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

async function getFileTimestamp(filePath: string): Promise<string> {
	const result = await Result.try({
		try: stat(filePath),
		catch: (error) => error,
	});
	return Result.isSuccess(result) ? result.value.mtime.toISOString() : new Date(0).toISOString();
}

function getQwenProject(filePath: string): string | undefined {
	const segments = filePath.split(path.sep);
	for (let index = segments.length - 4; index >= 0; index--) {
		if (
			segments[index] === 'projects' &&
			segments[index + 1] != null &&
			segments[index + 1] !== '' &&
			segments[index + 2] === 'chats'
		) {
			return segments[index + 1];
		}
	}
	return undefined;
}

function getQwenSessionId(filePath: string, record: Record<string, unknown>): string {
	const sessionId = readString(record, 'sessionId');
	if (sessionId != null) {
		return sessionId;
	}
	const project = getQwenProject(filePath) ?? 'unknown';
	const basename = path.basename(filePath, path.extname(filePath));
	const fileStem = basename === '' ? 'unknown' : basename;
	return `${project}-${fileStem}`;
}

function parseQwenLine(
	filePath: string,
	fallbackTimestamp: string,
	value: unknown,
): QwenUsageEntry | undefined {
	const record = asRecord(value);
	if (record == null || readString(record, 'type') !== 'assistant') {
		return undefined;
	}
	const usage = asRecord(record.usageMetadata);
	if (usage == null) {
		return undefined;
	}

	const inputTokens = toNonNegativeInteger(usage.promptTokenCount);
	const outputTokens = toNonNegativeInteger(usage.candidatesTokenCount);
	const reasoningTokens = toNonNegativeInteger(usage.thoughtsTokenCount);
	const cacheReadTokens = toNonNegativeInteger(usage.cachedContentTokenCount);
	const cacheCreationTokens = 0;
	if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && cacheReadTokens === 0) {
		return undefined;
	}

	return {
		timestamp: parseTimestamp(record.timestamp) ?? fallbackTimestamp,
		sessionId: getQwenSessionId(filePath, record),
		project: getQwenProject(filePath),
		model: readString(record, 'model') ?? DEFAULT_QWEN_MODEL,
		provider: DEFAULT_QWEN_PROVIDER,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		reasoningTokens,
	};
}

export async function parseQwenChatFile(filePath: string): Promise<QwenUsageEntry[]> {
	const fallbackTimestamp = await getFileTimestamp(filePath);
	const entries: QwenUsageEntry[] = [];
	const result = await Result.try({
		try: processJSONLFileByMarkers(filePath, QWEN_JSONL_MARKERS, (line) => {
			const parseResult = Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) => error,
			})();
			if (Result.isFailure(parseResult)) {
				return;
			}
			const entry = parseQwenLine(filePath, fallbackTimestamp, parseResult.value);
			if (entry != null) {
				entries.push(entry);
			}
		}),
		catch: (error) => error,
	});
	return Result.isFailure(result) ? [] : entries;
}

export async function loadQwenUsageEntries(): Promise<QwenUsageEntry[]> {
	const files = await discoverQwenChatFiles();
	if (files.length === 0) {
		return [];
	}

	const parsedFiles = await mapWithConcurrency(
		files,
		getDefaultWorkerThreadCount(files.length),
		parseQwenChatFile,
	);
	const entries: QwenUsageEntry[] = [];
	const seen = new Set<string>();
	for (const fileEntries of parsedFiles) {
		for (const entry of fileEntries) {
			const key = [
				'qwen',
				entry.sessionId,
				entry.timestamp,
				entry.model,
				entry.inputTokens,
				entry.outputTokens,
				entry.cacheReadTokens,
				entry.reasoningTokens,
			].join(':');
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			entries.push(entry);
		}
	}
	return entries;
}

if (import.meta.vitest != null) {
	describe('parseQwenChatFile', () => {
		it('loads assistant usage metadata from Qwen chat JSONL', async () => {
			await using fixture = await createFixture({
				projects: {
					myProject: {
						chats: {
							'chat-a.jsonl': [
								JSON.stringify({ type: 'user', text: 'hello' }),
								JSON.stringify({
									type: 'assistant',
									model: 'qwen3-coder-plus',
									timestamp: '2026-02-23T14:24:56.857Z',
									sessionId: 'session-json',
									usageMetadata: {
										promptTokenCount: 12414,
										candidatesTokenCount: 76,
										thoughtsTokenCount: 39,
										cachedContentTokenCount: 5,
									},
								}),
							].join('\n'),
						},
					},
				},
			});

			await expect(
				parseQwenChatFile(fixture.getPath('projects/myProject/chats/chat-a.jsonl')),
			).resolves.toEqual([
				{
					cacheCreationTokens: 0,
					cacheReadTokens: 5,
					inputTokens: 12414,
					model: 'qwen3-coder-plus',
					outputTokens: 76,
					project: 'myProject',
					provider: 'qwen',
					reasoningTokens: 39,
					sessionId: 'session-json',
					timestamp: '2026-02-23T14:24:56.857Z',
				},
			]);
		});

		it('falls back to project and filename when sessionId is missing', async () => {
			await using fixture = await createFixture({
				projects: {
					workspace: {
						chats: {
							'chat-b.jsonl': JSON.stringify({
								type: 'assistant',
								model: 'qwen3-coder-plus',
								timestamp: '2026-02-23T14:24:56.857Z',
								usageMetadata: {
									promptTokenCount: 1,
									candidatesTokenCount: 2,
								},
							}),
						},
					},
				},
			});

			await expect(
				parseQwenChatFile(fixture.getPath('projects/workspace/chats/chat-b.jsonl')),
			).resolves.toMatchObject([
				{
					project: 'workspace',
					sessionId: 'workspace-chat-b',
				},
			]);
		});
	});
}
