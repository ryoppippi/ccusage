import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readTextFile } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import {
	collectIndexedFileWorkerResults,
	getDefaultWorkerThreadCount,
	getFileWorkerThreadCount,
	mapWithConcurrency,
} from '@ccusage/internal/workers';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { discoverDroidSettingsFiles } from './paths.ts';

type DroidWorkerData = IndexedWorkerData<'ccusage:droid-worker', string>;

type DroidWorkerResponse = IndexedWorkerResultsMessage<DroidUsageEntry[]>;

type DroidTokenUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	thinkingTokens: number;
};

export type DroidUsageEntry = {
	timestamp: string;
	sessionId: string;
	model: string;
	provider: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function toNonNegativeInteger(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.floor(value);
}

function parseTokenUsage(value: unknown): DroidTokenUsage | null {
	const usage = asRecord(value);
	if (usage == null) {
		return null;
	}
	const tokens = {
		inputTokens: toNonNegativeInteger(usage.inputTokens),
		outputTokens: toNonNegativeInteger(usage.outputTokens),
		cacheCreationTokens: toNonNegativeInteger(usage.cacheCreationTokens),
		cacheReadTokens: toNonNegativeInteger(usage.cacheReadTokens),
		thinkingTokens: toNonNegativeInteger(usage.thinkingTokens),
	} satisfies DroidTokenUsage;
	const total =
		tokens.inputTokens +
		tokens.outputTokens +
		tokens.cacheCreationTokens +
		tokens.cacheReadTokens +
		tokens.thinkingTokens;
	return total > 0 ? tokens : null;
}

export function normalizeDroidModelName(model: string): string {
	return model
		.replace(/^custom:/iu, '')
		.replace(/\[[^\]]*\]/gu, '')
		.trim()
		.replace(/-+$/u, '')
		.toLowerCase()
		.replaceAll('.', '-')
		.replace(/\s+/gu, '-')
		.replace(/-+/gu, '-')
		.replace(/^-|-$/gu, '');
}

function normalizeDroidProvider(value: string | undefined): string {
	const normalized = value?.trim().toLowerCase().replaceAll('-', '_');
	if (normalized == null || normalized === '') {
		return 'unknown';
	}
	if (normalized === 'claude' || normalized === 'anthropic') {
		return 'anthropic';
	}
	if (normalized === 'openai') {
		return 'openai';
	}
	if (
		normalized === 'google' ||
		normalized === 'google_ai' ||
		normalized === 'gemini' ||
		normalized === 'vertex' ||
		normalized === 'vertex_ai'
	) {
		return 'google';
	}
	if (normalized === 'xai' || normalized === 'x_ai' || normalized === 'grok') {
		return 'xai';
	}
	return normalized;
}

function inferDroidProviderFromModel(model: string): string {
	if (/claude|opus|sonnet|haiku/u.test(model)) {
		return 'anthropic';
	}
	if (/(?:^|-)gpt-|chatgpt|(?:^|-)o\d/u.test(model)) {
		return 'openai';
	}
	if (/gemini/u.test(model)) {
		return 'google';
	}
	if (/grok/u.test(model)) {
		return 'xai';
	}
	return 'unknown';
}

function defaultModelFromProvider(provider: string): string {
	switch (provider) {
		case 'anthropic':
			return 'claude-unknown';
		case 'openai':
			return 'gpt-unknown';
		case 'google':
			return 'gemini-unknown';
		case 'xai':
			return 'grok-unknown';
		case 'unknown':
			return 'unknown';
		default:
			return `${provider}-unknown`;
	}
}

function extractDroidModelFromLine(line: string): string | null {
	const markerIndex = line.indexOf('Model:');
	if (markerIndex < 0) {
		return null;
	}
	const tail = line.slice(markerIndex + 'Model:'.length);
	const raw = tail.split(/["\\[]/u)[0]?.trim();
	if (raw == null || raw === '') {
		return null;
	}
	const normalized = normalizeDroidModelName(raw);
	return normalized === '' ? null : normalized;
}

async function extractModelFromSidecarJsonl(settingsPath: string): Promise<string | null> {
	const sidecarPath = settingsPath.replace(/\.settings\.json$/u, '.jsonl');
	if (sidecarPath === settingsPath) {
		return null;
	}
	const readResult = await Result.try({
		try: readTextFile(sidecarPath),
		catch: (error) => error,
	});
	if (Result.isFailure(readResult)) {
		return null;
	}
	const lines = readResult.value.split(/\r?\n/u).slice(0, 500);
	for (const line of lines) {
		const model = extractDroidModelFromLine(line);
		if (model != null) {
			return model;
		}
	}
	return null;
}

async function getSettingsTimestamp(
	settings: Record<string, unknown>,
	filePath: string,
): Promise<string | null> {
	const timestamp = readString(settings, 'providerLockTimestamp');
	if (timestamp != null) {
		const date = new Date(timestamp);
		if (Number.isFinite(date.getTime())) {
			return date.toISOString();
		}
	}
	const statResult = await Result.try({
		try: stat(filePath),
		catch: (error) => error,
	});
	if (Result.isFailure(statResult)) {
		return null;
	}
	return statResult.value.mtime.toISOString();
}

function getDroidSessionId(filePath: string): string {
	return path.basename(filePath).replace(/\.settings\.json$/u, '');
}

async function loadDroidSettingsEntry(filePath: string): Promise<DroidUsageEntry[]> {
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
	if (Result.isFailure(parseResult)) {
		return [];
	}

	const settings = asRecord(parseResult.value);
	if (settings == null) {
		return [];
	}
	const usage = parseTokenUsage(settings.tokenUsage);
	if (usage == null) {
		return [];
	}

	const explicitModel = readString(settings, 'model');
	const provider = normalizeDroidProvider(readString(settings, 'providerLock'));
	const sidecarModel = explicitModel == null ? await extractModelFromSidecarJsonl(filePath) : null;
	const model =
		explicitModel == null
			? (sidecarModel ?? defaultModelFromProvider(provider))
			: normalizeDroidModelName(explicitModel);
	const resolvedProvider = provider === 'unknown' ? inferDroidProviderFromModel(model) : provider;
	const timestamp = await getSettingsTimestamp(settings, filePath);
	if (timestamp == null) {
		return [];
	}

	return [
		{
			timestamp,
			sessionId: getDroidSessionId(filePath),
			model,
			provider: resolvedProvider,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheCreationTokens: usage.cacheCreationTokens,
			cacheReadTokens: usage.cacheReadTokens,
			reasoningTokens: usage.thinkingTokens,
		},
	];
}

function getDroidWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function collectDroidEntriesWithWorkers(
	files: string[],
): Promise<DroidUsageEntry[][] | null> {
	const workerCount = getDroidWorkerThreadCount(files.length);
	return collectIndexedFileWorkerResults<string, DroidUsageEntry[], DroidWorkerData>({
		items: files,
		workerCount,
		moduleUrl: import.meta.url,
		errorMessage: 'ccusage droid worker exited with code {code}',
		createWorkerData: (items) =>
			({
				kind: 'ccusage:droid-worker',
				items,
			}) satisfies DroidWorkerData,
	});
}

export async function loadDroidUsageEntries(): Promise<DroidUsageEntry[]> {
	const files = await discoverDroidSettingsFiles();
	const entryGroups =
		(await collectDroidEntriesWithWorkers(files)) ??
		(await mapWithConcurrency(
			files,
			getDefaultWorkerThreadCount(files.length),
			loadDroidSettingsEntry,
		));
	const processedSessions = new Set<string>();
	const entries: DroidUsageEntry[] = [];
	for (const entry of entryGroups.flat().sort((a, b) => compareStrings(a.timestamp, b.timestamp))) {
		if (processedSessions.has(entry.sessionId)) {
			continue;
		}
		processedSessions.add(entry.sessionId);
		entries.push(entry);
	}
	return entries;
}

async function runDroidWorker(data: DroidWorkerData): Promise<void> {
	const results: DroidWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await loadDroidSettingsEntry(item),
		});
	}
	parentPort?.postMessage({ results } satisfies DroidWorkerResponse);
}

function isDroidWorkerData(value: unknown): value is DroidWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:droid-worker'
	);
}

if (!isMainThread && isDroidWorkerData(workerData)) {
	void runDroidWorker(workerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('droid usage parser', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('normalizes Droid model names', () => {
			expect(normalizeDroidModelName('custom:Claude-Opus-4.5-Thinking-[Anthropic]-0')).toBe(
				'claude-opus-4-5-thinking-0',
			);
			expect(normalizeDroidModelName('Claude-Sonnet-4-[Anthropic]')).toBe('claude-sonnet-4');
			expect(normalizeDroidModelName('gemini-2.5-pro')).toBe('gemini-2-5-pro');
		});

		it('loads usage from Droid settings JSON files', async () => {
			await using fixture = await createFixture({
				'session-a.settings.json': JSON.stringify({
					model: 'Claude-Sonnet-4-[Anthropic]',
					providerLock: 'anthropic',
					providerLockTimestamp: '2026-05-01T01:02:03.000Z',
					tokenUsage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreationTokens: 20,
						cacheReadTokens: 10,
						thinkingTokens: 5,
					},
				}),
				'zero.settings.json': JSON.stringify({
					model: 'gpt-5',
					tokenUsage: {
						inputTokens: 0,
					},
				}),
			});
			vi.stubEnv('DROID_SESSIONS_DIR', fixture.path);

			await expect(loadDroidUsageEntries()).resolves.toEqual([
				{
					timestamp: '2026-05-01T01:02:03.000Z',
					sessionId: 'session-a',
					model: 'claude-sonnet-4',
					provider: 'anthropic',
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 20,
					cacheReadTokens: 10,
					reasoningTokens: 5,
				},
			]);
		});

		it('falls back to a sidecar JSONL model when settings omit the model', async () => {
			await using fixture = await createFixture({
				'session-b.settings.json': JSON.stringify({
					providerLock: 'anthropic',
					providerLockTimestamp: '2026-05-02T01:02:03.000Z',
					tokenUsage: {
						inputTokens: 10,
						outputTokens: 20,
					},
				}),
				'session-b.jsonl': '{"content":"Model: Claude Opus 4.5 Thinking [Anthropic]"}\n',
			});
			vi.stubEnv('DROID_SESSIONS_DIR', fixture.path);

			await expect(loadDroidUsageEntries()).resolves.toMatchObject([
				{
					sessionId: 'session-b',
					model: 'claude-opus-4-5-thinking',
					provider: 'anthropic',
				},
			]);
		});

		it('normalizes xAI provider locks', async () => {
			await using fixture = await createFixture({
				'session-c.settings.json': JSON.stringify({
					model: 'grok-4',
					providerLock: 'x-ai',
					providerLockTimestamp: '2026-05-03T01:02:03.000Z',
					tokenUsage: {
						inputTokens: 10,
						outputTokens: 20,
					},
				}),
			});
			vi.stubEnv('DROID_SESSIONS_DIR', fixture.path);

			await expect(loadDroidUsageEntries()).resolves.toMatchObject([
				{
					sessionId: 'session-c',
					model: 'grok-4',
					provider: 'xai',
				},
			]);
		});
	});
}
