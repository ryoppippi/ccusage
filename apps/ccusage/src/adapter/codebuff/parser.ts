import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readTextFile } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import { getDefaultWorkerThreadCount, mapWithConcurrency } from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { discoverCodebuffChatFiles } from './paths.ts';

export type CodebuffUsageEntry = {
	timestamp: string;
	sessionId: string;
	model: string;
	provider: string;
	credits: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	dedupKey: string;
};

type AssistantUsage = {
	model?: string;
	credits: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
};

const DEFAULT_CODEBUFF_MODEL = 'codebuff-unknown';

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

function toPositiveNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function pickPositiveInteger(record: Record<string, unknown>, keys: readonly string[]): number {
	for (const key of keys) {
		const value = toPositiveNumber(record[key]);
		if (value > 0) {
			return Math.trunc(value);
		}
	}
	return 0;
}

function emptyUsage(): AssistantUsage {
	return {
		credits: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
	};
}

function hasSignal(usage: AssistantUsage): boolean {
	return (
		usage.inputTokens > 0 ||
		usage.outputTokens > 0 ||
		usage.cacheCreationInputTokens > 0 ||
		usage.cacheReadInputTokens > 0 ||
		usage.credits > 0
	);
}

function mergeFallback(target: AssistantUsage, fallback: AssistantUsage): void {
	target.inputTokens ||= fallback.inputTokens;
	target.outputTokens ||= fallback.outputTokens;
	target.cacheCreationInputTokens ||= fallback.cacheCreationInputTokens;
	target.cacheReadInputTokens ||= fallback.cacheReadInputTokens;
	target.credits ||= fallback.credits;
	target.model ??= fallback.model;
}

function parseTimestampValue(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
	}
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		const ms = value < 10_000_000_000 ? value * 1000 : value;
		return new Date(ms).toISOString();
	}
	return undefined;
}

export function parseCodebuffChatIdTimestamp(chatId: string): string | undefined {
	const tIndex = chatId.indexOf('T');
	if (tIndex === -1) {
		return undefined;
	}
	const datePart = chatId.slice(0, tIndex);
	const timePart = chatId.slice(tIndex).replace('-', ':').replace('-', ':');
	return parseTimestampValue(`${datePart}${timePart}`);
}

function getMessageTimestamp(message: Record<string, unknown>): string | undefined {
	return (
		parseTimestampValue(message.timestamp) ??
		parseTimestampValue(message.createdAt) ??
		parseTimestampValue(asRecord(message.metadata)?.timestamp)
	);
}

function deriveCodebuffContext(filePath: string): {
	channel: string;
	project: string;
	chatId: string;
	sessionId: string;
} {
	const chatIdBasename = path.basename(path.dirname(filePath));
	const chatId = chatIdBasename === '' ? 'unknown' : chatIdBasename;
	const chatsDir = path.dirname(path.dirname(filePath));
	const projectDir = path.dirname(chatsDir);
	const projectBasename = path.basename(projectDir);
	const project = projectBasename === '' ? 'unknown' : projectBasename;
	const projectsDir = path.dirname(projectDir);
	const channelDir = path.dirname(projectsDir);
	const channelBasename = path.basename(channelDir);
	const channel = channelBasename === '' ? 'manicode' : channelBasename;
	return {
		channel,
		project,
		chatId,
		sessionId: `${channel}/${project}/${chatId}`,
	};
}

function isAssistantMessage(message: Record<string, unknown>): boolean {
	const role = readString(message, 'variant') ?? readString(message, 'role') ?? '';
	return role === 'ai' || role === 'agent' || role === 'assistant';
}

function parseUsageObject(value: unknown): AssistantUsage {
	const usage = emptyUsage();
	const record = asRecord(value);
	if (record == null) {
		return usage;
	}
	usage.inputTokens = pickPositiveInteger(record, [
		'inputTokens',
		'input_tokens',
		'promptTokens',
		'prompt_tokens',
	]);
	usage.outputTokens = pickPositiveInteger(record, [
		'outputTokens',
		'output_tokens',
		'completionTokens',
		'completion_tokens',
	]);
	usage.cacheReadInputTokens =
		pickPositiveInteger(record, ['cacheReadInputTokens', 'cache_read_input_tokens']) ||
		pickPositiveInteger(asRecord(record.promptTokensDetails) ?? {}, ['cachedTokens']) ||
		pickPositiveInteger(asRecord(record.prompt_tokens_details) ?? {}, ['cached_tokens']);
	usage.cacheCreationInputTokens = pickPositiveInteger(record, [
		'cacheCreationInputTokens',
		'cache_creation_input_tokens',
		'cacheCreationTokens',
		'cache_creation_tokens',
		'cachedTokensCreated',
		'cached_tokens_created',
	]);
	usage.credits = toPositiveNumber(record.credits);
	usage.model = readString(record, 'model');
	return usage;
}

function extractUsageFromRunState(metadata: Record<string, unknown>): AssistantUsage | undefined {
	const runState = asRecord(metadata.runState);
	const sessionState = asRecord(runState?.sessionState);
	const mainAgentState = asRecord(sessionState?.mainAgentState);
	const history = mainAgentState?.messageHistory;
	if (!Array.isArray(history)) {
		return undefined;
	}

	const usage = emptyUsage();
	let found = false;
	for (const item of history.toReversed()) {
		const entry = asRecord(item);
		if (entry == null || readString(entry, 'role') !== 'assistant') {
			continue;
		}
		const providerOptions = asRecord(entry.providerOptions);
		if (providerOptions == null) {
			continue;
		}
		const entryUsage = emptyUsage();
		mergeFallback(entryUsage, parseUsageObject(providerOptions.usage));
		const codebuff = asRecord(providerOptions.codebuff);
		mergeFallback(entryUsage, parseUsageObject(codebuff?.usage));
		entryUsage.model = readString(codebuff ?? {}, 'model') ?? entryUsage.model;
		if (hasSignal(entryUsage) || entryUsage.model != null) {
			found = true;
		}
		mergeFallback(usage, entryUsage);
	}
	return found ? usage : undefined;
}

function extractAssistantUsage(message: Record<string, unknown>): AssistantUsage {
	const usage = emptyUsage();
	const metadata = asRecord(message.metadata);
	if (metadata != null) {
		usage.model = readString(metadata, 'model');
		mergeFallback(usage, parseUsageObject(metadata.usage));
		mergeFallback(usage, parseUsageObject(asRecord(metadata.codebuff)?.usage));
		const runStateUsage = extractUsageFromRunState(metadata);
		if (runStateUsage != null) {
			mergeFallback(usage, runStateUsage);
		}
	}
	const credits = toPositiveNumber(message.credits);
	if (credits > 0 && usage.credits <= 0) {
		usage.credits = credits;
	}
	return usage;
}

function inferProvider(model: string): string {
	const normalized = model.toLowerCase();
	if (
		normalized.startsWith('claude-') ||
		normalized.startsWith('anthropic/') ||
		normalized.startsWith('anthropic.')
	) {
		return 'anthropic';
	}
	if (
		normalized.startsWith('gpt-') ||
		normalized.startsWith('o1') ||
		normalized.startsWith('o3') ||
		normalized.startsWith('o4') ||
		normalized.startsWith('openai/')
	) {
		return 'openai';
	}
	if (normalized.startsWith('gemini') || normalized.startsWith('google/')) {
		return 'google';
	}
	if (normalized.startsWith('grok') || normalized.startsWith('xai/')) {
		return 'xai';
	}
	return 'unknown';
}

function getDedupKey(
	message: Record<string, unknown>,
	sessionId: string,
	timestamp: string,
	model: string,
	usage: AssistantUsage,
	ordinal: number,
): string {
	const messageId = readString(message, 'id');
	if (messageId != null) {
		return `codebuff:${sessionId}:${messageId}`;
	}
	return `codebuff:${sessionId}:${timestamp}:${model}:${ordinal}:${usage.inputTokens}:${usage.outputTokens}:${usage.cacheReadInputTokens}:${usage.cacheCreationInputTokens}`;
}

async function getFileModifiedTimestamp(filePath: string): Promise<string> {
	const result = await Result.try({
		try: stat(filePath),
		catch: (error) => error,
	});
	if (Result.isFailure(result)) {
		return new Date(0).toISOString();
	}
	return result.value.mtime.toISOString();
}

async function loadCodebuffChatFile(filePath: string): Promise<CodebuffUsageEntry[]> {
	const readResult = await Result.try({
		try: readTextFile(filePath),
		catch: (error) => error,
	});
	if (Result.isFailure(readResult)) {
		return [];
	}

	const parseResult = Result.try({
		try: () => JSON.parse(readResult.value) as unknown,
		catch: (error) => error,
	})();
	if (Result.isFailure(parseResult) || !Array.isArray(parseResult.value)) {
		return [];
	}

	const context = deriveCodebuffContext(filePath);
	const chatTimestamp = parseCodebuffChatIdTimestamp(context.chatId);
	const fileTimestamp = await getFileModifiedTimestamp(filePath);
	const entries: CodebuffUsageEntry[] = [];
	for (const [ordinal, rawMessage] of parseResult.value.entries()) {
		const message = asRecord(rawMessage);
		if (message == null || !isAssistantMessage(message)) {
			continue;
		}
		const usage = extractAssistantUsage(message);
		if (!hasSignal(usage)) {
			continue;
		}
		const timestamp = getMessageTimestamp(message) ?? chatTimestamp ?? fileTimestamp;
		const model = usage.model ?? DEFAULT_CODEBUFF_MODEL;
		entries.push({
			timestamp,
			sessionId: context.sessionId,
			model,
			provider: inferProvider(model),
			credits: usage.credits,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheCreationInputTokens: usage.cacheCreationInputTokens,
			cacheReadInputTokens: usage.cacheReadInputTokens,
			dedupKey: getDedupKey(message, context.sessionId, timestamp, model, usage, ordinal),
		});
	}
	return entries;
}

export async function loadCodebuffUsageEntries(): Promise<CodebuffUsageEntry[]> {
	const files = await discoverCodebuffChatFiles();
	const entryGroups = await mapWithConcurrency(
		files,
		getDefaultWorkerThreadCount(files.length),
		loadCodebuffChatFile,
	);
	const deduped = new Map<string, CodebuffUsageEntry>();
	for (const entry of entryGroups.flat()) {
		deduped.set(entry.dedupKey, entry);
	}
	return Array.from(deduped.values()).sort(
		(a, b) => compareStrings(a.timestamp, b.timestamp) || compareStrings(a.dedupKey, b.dedupKey),
	);
}

if (import.meta.vitest != null) {
	describe('loadCodebuffUsageEntries', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads assistant usage from chat-messages JSON files', async () => {
			await using fixture = await createFixture({
				projects: {
					'project-a': {
						chats: {
							'2026-01-02T03-04-05.000Z': {
								'chat-messages.json': JSON.stringify([
									{ role: 'user', text: 'hello' },
									{
										id: 'assistant-message',
										role: 'assistant',
										timestamp: '2026-01-02T03:04:06.000Z',
										metadata: {
											model: 'claude-sonnet-4-20250514',
											usage: {
												inputTokens: 100,
												outputTokens: 50,
												cacheCreationInputTokens: 20,
												cacheReadInputTokens: 10,
											},
										},
										credits: 1.25,
									},
								]),
							},
						},
					},
				},
			});
			vi.stubEnv('CODEBUFF_DATA_DIR', fixture.path);

			await expect(loadCodebuffUsageEntries()).resolves.toEqual([
				{
					timestamp: '2026-01-02T03:04:06.000Z',
					sessionId: `${path.basename(fixture.path)}/project-a/2026-01-02T03-04-05.000Z`,
					model: 'claude-sonnet-4-20250514',
					provider: 'anthropic',
					credits: 1.25,
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationInputTokens: 20,
					cacheReadInputTokens: 10,
					dedupKey: `codebuff:${path.basename(fixture.path)}/project-a/2026-01-02T03-04-05.000Z:assistant-message`,
				},
			]);
		});

		it('keeps upstream message ids scoped to their chat sessions', async () => {
			await using fixture = await createFixture({
				projects: {
					project: {
						chats: {
							'2026-01-02T03-04-05.000Z': {
								'chat-messages.json': JSON.stringify([
									{
										id: 'assistant-message',
										role: 'assistant',
										metadata: {
											model: 'claude-sonnet-4-20250514',
											usage: { inputTokens: 100, outputTokens: 50 },
										},
									},
								]),
							},
							'2026-01-03T03-04-05.000Z': {
								'chat-messages.json': JSON.stringify([
									{
										id: 'assistant-message',
										role: 'assistant',
										metadata: {
											model: 'claude-sonnet-4-20250514',
											usage: { inputTokens: 200, outputTokens: 60 },
										},
									},
								]),
							},
						},
					},
				},
			});
			vi.stubEnv('CODEBUFF_DATA_DIR', fixture.path);

			const entries = await loadCodebuffUsageEntries();
			expect(entries).toHaveLength(2);
			expect(entries.map((entry) => entry.dedupKey)).toEqual([
				`codebuff:${path.basename(fixture.path)}/project/2026-01-02T03-04-05.000Z:assistant-message`,
				`codebuff:${path.basename(fixture.path)}/project/2026-01-03T03-04-05.000Z:assistant-message`,
			]);
		});

		it('classifies cachedTokensCreated as cache creation tokens', async () => {
			await using fixture = await createFixture({
				projects: {
					project: {
						chats: {
							'2026-01-02T03-04-05.000Z': {
								'chat-messages.json': JSON.stringify([
									{
										role: 'assistant',
										metadata: {
											model: 'claude-sonnet-4-20250514',
											usage: {
												inputTokens: 100,
												outputTokens: 50,
												cachedTokensCreated: 25,
											},
										},
									},
								]),
							},
						},
					},
				},
			});
			vi.stubEnv('CODEBUFF_DATA_DIR', fixture.path);

			await expect(loadCodebuffUsageEntries()).resolves.toMatchObject([
				{
					cacheCreationInputTokens: 25,
					cacheReadInputTokens: 0,
				},
			]);
		});

		it('falls back to runState provider usage and chat id timestamps', async () => {
			await using fixture = await createFixture({
				projects: {
					'project-a': {
						chats: {
							'2026-01-02T03-04-05.000Z': {
								'chat-messages.json': JSON.stringify([
									{
										variant: 'agent',
										metadata: {
											runState: {
												sessionState: {
													mainAgentState: {
														messageHistory: [
															{ role: 'user', providerOptions: {} },
															{
																role: 'assistant',
																providerOptions: {
																	codebuff: {
																		model: 'openai/gpt-5',
																		usage: {
																			prompt_tokens: 100,
																			completion_tokens: 50,
																			prompt_tokens_details: { cached_tokens: 10 },
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
								]),
							},
						},
					},
				},
			});
			vi.stubEnv('CODEBUFF_DATA_DIR', fixture.path);

			await expect(loadCodebuffUsageEntries()).resolves.toMatchObject([
				{
					timestamp: '2026-01-02T03:04:05.000Z',
					model: 'openai/gpt-5',
					provider: 'openai',
					inputTokens: 100,
					outputTokens: 50,
					cacheReadInputTokens: 10,
				},
			]);
		});
	});

	describe('parseCodebuffChatIdTimestamp', () => {
		it('restores time separators after the date part', () => {
			expect(parseCodebuffChatIdTimestamp('2026-01-02T03-04-05.000Z')).toBe(
				'2026-01-02T03:04:05.000Z',
			);
		});
	});
}
