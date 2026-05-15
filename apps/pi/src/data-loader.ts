import type { IndexedWorkerItem } from '@ccusage/internal/workers';
import process from 'node:process';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createResultSlots } from '@ccusage/internal/array';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { processJSONLFileByLine } from '@ccusage/internal/jsonl';
import { compareStringsByOrder } from '@ccusage/internal/sort';
import { chunkIndexedItemsByFileSize, getFileWorkerThreadCount } from '@ccusage/internal/workers';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import {
	extractPiAgentProject,
	extractPiAgentSessionId,
	getPiAgentPaths,
	piAgentMessageSchema,
	transformPiAgentUsage,
} from './_pi-agent.ts';

export type Source = 'claude-code' | 'pi-agent';

export type LoadOptions = {
	piPath?: string;
	since?: string;
	until?: string;
	timezone?: string;
	order?: 'asc' | 'desc';
};

export type DailyUsageWithSource = {
	date: string;
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
};

export type SessionUsageWithSource = {
	sessionId: string;
	projectPath: string;
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	lastActivity: string;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
};

export type MonthlyUsageWithSource = {
	month: string;
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
};

async function globPiAgentFiles(paths: string[]): Promise<string[]> {
	const allFiles: string[] = [];
	for (const basePath of paths) {
		const files = await collectFilesRecursive(basePath, { extension: '.jsonl' });
		allFiles.push(...files);
	}
	return allFiles;
}

function formatDate(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	return date.toLocaleDateString('en-CA', { timeZone: tz });
}

function formatMonth(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const formatted = date.toLocaleDateString('en-CA', { timeZone: tz });
	return formatted.slice(0, 7);
}

function normalizeDate(value: string): string {
	return value.replace(/-/g, '');
}

function isInDateRange(date: string, since?: string, until?: string): boolean {
	const dateKey = normalizeDate(date);
	if (since != null && dateKey < normalizeDate(since)) {
		return false;
	}
	if (until != null && dateKey > normalizeDate(until)) {
		return false;
	}
	return true;
}

type EntryData = {
	timestamp: string;
	model: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
	project: string;
	sessionId: string;
	tokenTotal: number;
};

type PiWorkerData = {
	kind: 'ccusage:pi-usage-worker';
	items: Array<IndexedWorkerItem<string>>;
};

type PiWorkerResponse = {
	results: Array<{ index: number; result: EntryData[] }>;
};

function getJSONLWorkerThreadCount(fileCount: number): number {
	return getFileWorkerThreadCount({
		itemCount: fileCount,
		isMainThread,
		moduleUrl: import.meta.url,
		envValue: process.env.CCUSAGE_JSONL_WORKER_THREADS,
		isTest: import.meta.vitest != null,
		preferMoreWorkers: true,
	});
}

async function parsePiAgentFile(file: string): Promise<EntryData[]> {
	const project = extractPiAgentProject(file);
	const sessionId = extractPiAgentSessionId(file);
	const entries: EntryData[] = [];
	try {
		await processJSONLFileByLine(file, (line) => {
			if (!line.includes('"message"') || !line.includes('"usage"')) {
				return;
			}
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(piAgentMessageSchema, parsed);
				if (!result.success) {
					return;
				}

				const data = result.output;
				const transformed = transformPiAgentUsage(data);
				if (transformed == null) {
					return;
				}

				entries.push({
					timestamp: data.timestamp,
					model: transformed.model,
					inputTokens: transformed.usage.input_tokens,
					outputTokens: transformed.usage.output_tokens,
					cacheCreationTokens: transformed.usage.cache_creation_input_tokens,
					cacheReadTokens: transformed.usage.cache_read_input_tokens,
					cost: transformed.costUSD ?? 0,
					project,
					sessionId,
					tokenTotal: transformed.totalTokens,
				});
			} catch {}
		});
	} catch {
		return [];
	}

	return entries;
}

async function collectWithPiWorkers(files: string[]): Promise<EntryData[][] | null> {
	const workerCount = getJSONLWorkerThreadCount(files.length);
	if (workerCount === 0) {
		return null;
	}

	const indexedItems = files.map<IndexedWorkerItem<string>>((item, index) => ({ index, item }));
	const chunks = await chunkIndexedItemsByFileSize(indexedItems, workerCount, (item) => item);
	const workerResults: Array<Promise<PiWorkerResponse['results']>> = [];
	for (const chunk of chunks) {
		workerResults.push(
			new Promise<PiWorkerResponse['results']>((resolve, reject) => {
				const worker = new Worker(new URL(import.meta.url), {
					workerData: {
						kind: 'ccusage:pi-usage-worker',
						items: chunk,
					} satisfies PiWorkerData,
				});
				worker.once('message', (message: PiWorkerResponse) => {
					resolve(message.results);
				});
				worker.once('error', reject);
				worker.once('exit', (code) => {
					if (code !== 0) {
						reject(new Error(`pi-agent usage worker exited with code ${code}`));
					}
				});
			}),
		);
	}

	const resultGroups = await Promise.all(workerResults);
	const orderedResults = createResultSlots<EntryData[]>(files.length);
	for (const results of resultGroups) {
		for (const { index, result } of results) {
			orderedResults[index] = result;
		}
	}

	return orderedResults;
}

export async function loadPiAgentData(options?: LoadOptions): Promise<EntryData[]> {
	const piPaths = getPiAgentPaths(options?.piPath);
	if (piPaths.length === 0) {
		return [];
	}

	const files = await globPiAgentFiles(piPaths);
	if (files.length === 0) {
		return [];
	}

	const processedHashes = new Set<string>();
	const entries: EntryData[] = [];
	const fileResults =
		(await collectWithPiWorkers(files)) ?? (await Promise.all(files.map(parsePiAgentFile)));

	for (const fileEntries of fileResults) {
		for (const entry of fileEntries) {
			const hash = `pi:${entry.project}:${entry.sessionId}:${entry.timestamp}:${entry.tokenTotal}`;
			if (processedHashes.has(hash)) {
				continue;
			}
			processedHashes.add(hash);
			entries.push(entry);
		}
	}

	return entries;
}

async function runPiUsageWorker(data: PiWorkerData): Promise<void> {
	const results: PiWorkerResponse['results'] = [];
	for (const { index, item } of data.items) {
		results.push({
			index,
			result: await parsePiAgentFile(item),
		});
	}

	parentPort?.postMessage({ results } satisfies PiWorkerResponse);
}

function isPiWorkerData(value: unknown): value is PiWorkerData {
	return (
		value != null &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'ccusage:pi-usage-worker'
	);
}

const currentWorkerData: unknown = workerData;
if (!isMainThread && isPiWorkerData(currentWorkerData)) {
	void runPiUsageWorker(currentWorkerData).catch(() => {
		process.exit(1);
	});
}

function aggregateByModel(entries: EntryData[]): Map<
	string,
	{
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}
> {
	const modelMap = new Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			cost: number;
		}
	>();

	for (const entry of entries) {
		const model = entry.model ?? 'unknown';
		const existing = modelMap.get(model) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
		};

		existing.inputTokens += entry.inputTokens;
		existing.outputTokens += entry.outputTokens;
		existing.cacheCreationTokens += entry.cacheCreationTokens;
		existing.cacheReadTokens += entry.cacheReadTokens;
		existing.cost += entry.cost;

		modelMap.set(model, existing);
	}

	return modelMap;
}

function createBreakdowns(
	modelMap: Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			cost: number;
		}
	>,
): Array<{
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
}> {
	return Array.from(modelMap.entries()).map(([modelName, data]) => ({
		modelName,
		...data,
	}));
}

function calculateTotals(entries: EntryData[]): {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	let totalCost = 0;

	for (const entry of entries) {
		inputTokens += entry.inputTokens;
		outputTokens += entry.outputTokens;
		cacheCreationTokens += entry.cacheCreationTokens;
		cacheReadTokens += entry.cacheReadTokens;
		totalCost += entry.cost;
	}

	return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCost };
}

export async function loadPiAgentDailyData(options?: LoadOptions): Promise<DailyUsageWithSource[]> {
	const entries = await loadPiAgentData(options);

	const grouped = new Map<string, EntryData[]>();
	for (const entry of entries) {
		const date = formatDate(entry.timestamp, options?.timezone);
		if (!isInDateRange(date, options?.since, options?.until)) {
			continue;
		}

		const existing = grouped.get(date) ?? [];
		existing.push(entry);
		grouped.set(date, existing);
	}

	const results: DailyUsageWithSource[] = [];
	for (const [date, dateEntries] of grouped) {
		const modelMap = aggregateByModel(dateEntries);
		const totals = calculateTotals(dateEntries);
		const modelsUsed = Array.from(modelMap.keys());
		const modelBreakdowns = createBreakdowns(modelMap);

		results.push({
			date,
			source: 'pi-agent',
			...totals,
			modelsUsed,
			modelBreakdowns,
		});
	}

	const order = options?.order ?? 'desc';
	results.sort((a, b) => compareStringsByOrder(a.date, b.date, order));

	return results;
}

export async function loadPiAgentSessionData(
	options?: LoadOptions,
): Promise<SessionUsageWithSource[]> {
	const entries = await loadPiAgentData(options);

	const grouped = new Map<string, EntryData[]>();
	for (const entry of entries) {
		const key = `${entry.project}\x00${entry.sessionId}`;
		const existing = grouped.get(key) ?? [];
		existing.push(entry);
		grouped.set(key, existing);
	}

	const results: SessionUsageWithSource[] = [];
	for (const [key, sessionEntries] of grouped) {
		const [project, sessionId] = key.split('\x00') as [string, string];
		const modelMap = aggregateByModel(sessionEntries);
		const totals = calculateTotals(sessionEntries);
		const modelsUsed = Array.from(modelMap.keys());
		const modelBreakdowns = createBreakdowns(modelMap);

		const lastActivity = sessionEntries.reduce((latest, entry) => {
			return entry.timestamp > latest ? entry.timestamp : latest;
		}, sessionEntries[0]?.timestamp ?? '');

		const lastDate = formatDate(lastActivity, options?.timezone);
		if (!isInDateRange(lastDate, options?.since, options?.until)) {
			continue;
		}

		results.push({
			sessionId,
			projectPath: project,
			source: 'pi-agent',
			...totals,
			lastActivity: lastDate,
			modelsUsed,
			modelBreakdowns,
		});
	}

	const order = options?.order ?? 'desc';
	results.sort((a, b) => compareStringsByOrder(a.lastActivity, b.lastActivity, order));

	return results;
}

export async function loadPiAgentMonthlyData(
	options?: LoadOptions,
): Promise<MonthlyUsageWithSource[]> {
	const entries = await loadPiAgentData(options);

	const grouped = new Map<string, EntryData[]>();
	for (const entry of entries) {
		const month = formatMonth(entry.timestamp, options?.timezone);
		const date = formatDate(entry.timestamp, options?.timezone);
		if (!isInDateRange(date, options?.since, options?.until)) {
			continue;
		}

		const existing = grouped.get(month) ?? [];
		existing.push(entry);
		grouped.set(month, existing);
	}

	const results: MonthlyUsageWithSource[] = [];
	for (const [month, monthEntries] of grouped) {
		const modelMap = aggregateByModel(monthEntries);
		const totals = calculateTotals(monthEntries);
		const modelsUsed = Array.from(modelMap.keys());
		const modelBreakdowns = createBreakdowns(modelMap);

		results.push({
			month,
			source: 'pi-agent',
			...totals,
			modelsUsed,
			modelBreakdowns,
		});
	}

	const order = options?.order ?? 'desc';
	results.sort((a, b) => compareStringsByOrder(a.month, b.month, order));

	return results;
}

if (import.meta.vitest != null) {
	describe('loadPiAgentDailyData', () => {
		it('loads pi-agent JSONL usage entries', async () => {
			await using fixture = await createFixture({
				sessions: {
					project: {
						'session-id.jsonl': JSON.stringify({
							type: 'message',
							timestamp: '2026-01-02T03:04:05.000Z',
							message: {
								role: 'assistant',
								model: 'claude-opus-4-20250514',
								usage: {
									input: 100,
									output: 50,
									cacheRead: 10,
									cacheWrite: 20,
									totalTokens: 180,
									cost: {
										total: 0.05,
									},
								},
							},
						}),
					},
				},
			});

			const rows = await loadPiAgentDailyData({
				piPath: fixture.getPath('sessions'),
				timezone: 'UTC',
				order: 'asc',
			});

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				date: '2026-01-02',
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 20,
				cacheReadTokens: 10,
				totalCost: 0.05,
				modelsUsed: ['[pi] claude-opus-4-20250514'],
			});
		});
	});
}
