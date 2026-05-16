import type { Args, Command } from 'gunshi';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { Spinner } from 'picospinner';
import { getAmpPath, loadAmpUsageEvents } from '../../../amp/src/data-loader.ts';
import { AmpPricingSource } from '../../../amp/src/pricing.ts';
import {
	CODEX_HOME_ENV,
	DEFAULT_CODEX_DIR,
	DEFAULT_SESSION_SUBDIR,
} from '../../../codex/src/_consts.ts';
import { resolveCodexSpeed } from '../../../codex/src/codex-config.ts';
import { loadTokenUsageEvents } from '../../../codex/src/data-loader.ts';
import {
	isWithinRange as isCodexWithinRange,
	toDateKey,
	toMonthKey,
} from '../../../codex/src/date-utils.ts';
import { CodexPricingSource } from '../../../codex/src/pricing.ts';
import { calculateCostUSD as calculateCodexCostUSD } from '../../../codex/src/token-utils.ts';
import { calculateCostForEntry } from '../../../opencode/src/cost-utils.ts';
import { getOpenCodePath, loadOpenCodeMessages } from '../../../opencode/src/data-loader.ts';
import { getPiAgentPaths } from '../../../pi/src/_pi-agent.ts';
import {
	loadPiAgentDailyData,
	loadPiAgentMonthlyData,
	loadPiAgentSessionData,
} from '../../../pi/src/data-loader.ts';
import {
	CLAUDE_CONFIG_DIR_ENV,
	CLAUDE_PROJECTS_DIR_NAME,
	DEFAULT_CLAUDE_CODE_PATH,
	DEFAULT_CLAUDE_CONFIG_PATH,
	USER_HOME_DIR,
} from '../consts.ts';
import { loadDailyUsageData, loadMonthlyUsageData, loadSessionData } from '../data-loader.ts';
import { formatDate, formatDateCompact, getDateStringWeek } from '../date-utils.ts';
import { logger, writeStdoutLine } from '../logger.ts';

type AgentId = 'claude' | 'codex' | 'opencode' | 'amp' | 'pi';
type ReportKind = 'daily' | 'weekly' | 'monthly' | 'session';

type AllRow = {
	period: string;
	agent: AgentId | 'all';
	modelsUsed: string[];
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	metadata?: Record<string, unknown>;
	agentBreakdowns?: AllRow[];
};

type AllOptions = {
	all?: boolean;
	json?: boolean;
	since?: string;
	until?: string;
	timezone?: string;
	compact?: boolean;
	offline?: boolean;
};

const agentIds = ['claude', 'codex', 'opencode', 'amp', 'pi'] as const satisfies AgentId[];
const agentLabels = {
	all: 'All',
	claude: 'Claude',
	codex: 'Codex',
	opencode: 'OpenCode',
	amp: 'Amp',
	pi: 'pi-agent',
} as const satisfies Record<AgentId | 'all', string>;

const allArgs = {
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output in JSON format',
		default: false,
	},
	since: {
		type: 'string',
		short: 's',
		description: 'Filter from date (YYYY-MM-DD or YYYYMMDD)',
	},
	until: {
		type: 'string',
		short: 'u',
		description: 'Filter until date (inclusive)',
	},
	timezone: {
		type: 'string',
		short: 'z',
		description: 'Timezone for date grouping (IANA)',
	},
	all: {
		type: 'boolean',
		description:
			'Accepted for compatibility; all detected supported agents are included by default',
		default: false,
	},
	compact: {
		type: 'boolean',
		description: 'Force compact table layout for narrow terminals',
		default: false,
	},
	offline: {
		type: 'boolean',
		negatable: true,
		short: 'O',
		description: 'Use cached pricing data where supported',
		default: false,
	},
} as const satisfies Args;

function normalizeDateFilter(value: string | undefined): string | undefined {
	if (value == null || value === '') {
		return undefined;
	}
	if (/^\d{8}$/u.test(value)) {
		return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
	}
	if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		return value;
	}
	throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD or YYYYMMDD.`);
}

function toCompactDate(value: string | undefined): string | undefined {
	return value?.replaceAll('-', '');
}

function isWithinRange(
	date: string,
	since: string | undefined,
	until: string | undefined,
): boolean {
	if (since != null && date < since) {
		return false;
	}
	if (until != null && date > until) {
		return false;
	}
	return true;
}

export function resolveAllAgents(options: AllOptions): AgentId[] {
	void options;
	return [...agentIds];
}

function getCodexSessionsPath(): string {
	const codexHome = process.env[CODEX_HOME_ENV]?.trim();
	return path.join(
		codexHome == null || codexHome === '' ? DEFAULT_CODEX_DIR : path.resolve(codexHome),
		DEFAULT_SESSION_SUBDIR,
	);
}

function getClaudeProjectPaths(): string[] {
	const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
	const basePaths =
		envPaths === ''
			? [DEFAULT_CLAUDE_CONFIG_PATH, path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH)]
			: envPaths
					.split(',')
					.map((entry) => path.resolve(entry.trim()))
					.filter((entry) => entry !== '');
	return basePaths.map((basePath) => path.join(basePath, CLAUDE_PROJECTS_DIR_NAME));
}

async function hasFiles(root: string | null, extension: `.${string}`): Promise<boolean> {
	if (root == null) {
		return false;
	}
	return (await collectFilesRecursive(root, { extension })).length > 0;
}

function hasOpenCodeDatabase(openCodePath: string): boolean {
	if (existsSync(path.join(openCodePath, 'opencode.db'))) {
		return true;
	}
	try {
		return readdirSync(openCodePath).some((entry) => /^opencode-[\w-]+\.db$/u.test(entry));
	} catch {
		return false;
	}
}

async function detectAllAgents(options: AllOptions): Promise<AgentId[]> {
	void options;
	const [claude, codex, opencode, amp, pi] = await Promise.all([
		Promise.all(
			getClaudeProjectPaths().map(async (projectsPath) => hasFiles(projectsPath, '.jsonl')),
		).then((results) => results.some(Boolean)),
		hasFiles(getCodexSessionsPath(), '.jsonl'),
		(async () => {
			const openCodePath = getOpenCodePath();
			if (openCodePath == null) {
				return false;
			}
			return (
				hasOpenCodeDatabase(openCodePath) ||
				(await hasFiles(path.join(openCodePath, 'storage', 'message'), '.json'))
			);
		})(),
		(async () => {
			const ampPath = getAmpPath();
			return ampPath != null && (await hasFiles(path.join(ampPath, 'threads'), '.json'));
		})(),
		Promise.all(
			getPiAgentPaths().map(async (sessionsPath) => hasFiles(sessionsPath, '.jsonl')),
		).then((results) => results.some(Boolean)),
	]);
	const detected: AgentId[] = [];
	if (claude) {
		detected.push('claude');
	}
	if (codex) {
		detected.push('codex');
	}
	if (opencode) {
		detected.push('opencode');
	}
	if (amp) {
		detected.push('amp');
	}
	if (pi) {
		detected.push('pi');
	}
	return detected;
}

function createEmptyRow(period: string, agent: AgentId | 'all'): AllRow {
	return {
		period,
		agent,
		modelsUsed: [],
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		totalCost: 0,
	};
}

function addModels(target: Set<string>, models: Iterable<string>): void {
	for (const model of models) {
		target.add(model);
	}
}

function getRowAgents(row: AllRow): AgentId[] {
	const agents = row.metadata?.agents;
	if (Array.isArray(agents)) {
		return agents.filter((agent): agent is AgentId => agentIds.includes(agent as AgentId));
	}
	return row.agent === 'all' ? [] : [row.agent];
}

function aggregateRowsByPeriod(rows: AllRow[], getPeriod: (row: AllRow) => string): AllRow[] {
	const groups = new Map<
		string,
		{ row: AllRow; models: Set<string>; agents: Set<AgentId>; agentBreakdowns: AllRow[] }
	>();
	for (const row of rows) {
		const period = getPeriod(row);
		const group = groups.get(period) ?? {
			row: createEmptyRow(period, 'all'),
			models: new Set(),
			agents: new Set<AgentId>(),
			agentBreakdowns: [],
		};
		if (!groups.has(period)) {
			groups.set(period, group);
		}
		group.row.inputTokens += row.inputTokens;
		group.row.outputTokens += row.outputTokens;
		group.row.cacheCreationTokens += row.cacheCreationTokens;
		group.row.cacheReadTokens += row.cacheReadTokens;
		group.row.totalTokens += row.totalTokens;
		group.row.totalCost += row.totalCost;
		addModels(group.models, row.modelsUsed);
		for (const agent of getRowAgents(row)) {
			group.agents.add(agent);
		}
		group.agentBreakdowns.push({ ...row, period });
	}
	return Array.from(groups.values(), ({ row, models, agents, agentBreakdowns }) => ({
		...row,
		modelsUsed: Array.from(models).sort(compareStrings),
		metadata: { ...row.metadata, agents: Array.from(agents).sort(compareStrings) },
		agentBreakdowns: agentBreakdowns.sort((a, b) => compareStrings(a.agent, b.agent)),
	})).sort((a, b) => compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent));
}

async function loadClaudeRows(kind: ReportKind, options: AllOptions): Promise<AllRow[]> {
	const since = toCompactDate(normalizeDateFilter(options.since));
	const until = toCompactDate(normalizeDateFilter(options.until));
	const loaderOptions = {
		offline: options.offline,
		since,
		until,
		timezone: options.timezone,
	};

	if (kind === 'session') {
		const rows = await loadSessionData(loaderOptions);
		return rows.map((row) => ({
			period: row.sessionId,
			agent: 'claude',
			modelsUsed: row.modelsUsed,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheCreationTokens: row.cacheCreationTokens,
			cacheReadTokens: row.cacheReadTokens,
			totalTokens:
				row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
			totalCost: row.totalCost,
			metadata: {
				lastActivity: row.lastActivity,
			},
		}));
	}

	if (kind === 'monthly') {
		const rows = await loadMonthlyUsageData(loaderOptions);
		return rows.map((row) => ({
			period: row.month,
			agent: 'claude',
			modelsUsed: row.modelsUsed,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheCreationTokens: row.cacheCreationTokens,
			cacheReadTokens: row.cacheReadTokens,
			totalTokens:
				row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
			totalCost: row.totalCost,
		}));
	}

	const rows = await loadDailyUsageData(loaderOptions);
	return rows.map((row) => ({
		period: row.date,
		agent: 'claude',
		modelsUsed: row.modelsUsed,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		cacheReadTokens: row.cacheReadTokens,
		totalTokens: row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
		totalCost: row.totalCost,
	}));
}

type AllLoadContext = {
	pricingFetcher?: LiteLLMPricingFetcher;
	progress?: AllLoadProgress;
};

type AllLoadProgress = {
	start: (agent: AgentId) => void;
	succeed: (agent: AgentId, rows: number) => void;
	fail: (agent: AgentId, error: unknown) => void;
	stop: () => void;
};

type AllLoadProgressState = 'loading' | 'succeeded' | 'failed';

type CodexModelUsage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

type CodexGroup = {
	row: AllRow;
	models: Map<string, CodexModelUsage>;
	reasoningOutputTokens: number;
	lastActivity: string;
};

function addCodexUsage(
	target: CodexModelUsage,
	event: {
		inputTokens: number;
		cachedInputTokens: number;
		outputTokens: number;
		reasoningOutputTokens: number;
		totalTokens: number;
	},
): void {
	target.inputTokens += event.inputTokens;
	target.cachedInputTokens += event.cachedInputTokens;
	target.outputTokens += event.outputTokens;
	target.reasoningOutputTokens += event.reasoningOutputTokens;
	target.totalTokens += event.totalTokens;
}

function createCodexUsage(): CodexModelUsage {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};
}

async function loadCodexRows(
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
): Promise<AllRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const speed = await resolveCodexSpeed('auto');
	const { events } = await loadTokenUsageEvents();
	using pricingSource = new CodexPricingSource({
		fetcher: context.pricingFetcher,
		offline: options.offline,
		speed,
	});
	const groups = new Map<string, CodexGroup>();

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}
		const date = toDateKey(event.timestamp, options.timezone);
		if (!isCodexWithinRange(date, since, until)) {
			continue;
		}
		const period =
			kind === 'session'
				? event.sessionId
				: kind === 'monthly'
					? toMonthKey(event.timestamp, options.timezone)
					: date;
		const group = groups.get(period) ?? {
			row: createEmptyRow(period, 'codex'),
			models: new Map<string, CodexModelUsage>(),
			reasoningOutputTokens: 0,
			lastActivity: event.timestamp,
		};
		if (!groups.has(period)) {
			groups.set(period, group);
		}

		group.row.inputTokens += event.inputTokens;
		group.row.outputTokens += event.outputTokens;
		group.row.cacheReadTokens += event.cachedInputTokens;
		group.row.totalTokens += event.inputTokens + event.outputTokens + event.cachedInputTokens;
		group.reasoningOutputTokens += event.reasoningOutputTokens;
		if (event.timestamp > group.lastActivity) {
			group.lastActivity = event.timestamp;
		}

		const modelUsage = group.models.get(modelName) ?? createCodexUsage();
		if (!group.models.has(modelName)) {
			group.models.set(modelName, modelUsage);
		}
		addCodexUsage(modelUsage, event);
	}

	const pricingByModel = new Map<string, Awaited<ReturnType<CodexPricingSource['getPricing']>>>();
	for (const group of groups.values()) {
		for (const model of group.models.keys()) {
			if (!pricingByModel.has(model)) {
				pricingByModel.set(model, await pricingSource.getPricing(model));
			}
		}
	}

	return Array.from(groups.values(), ({ row, models, reasoningOutputTokens, lastActivity }) => {
		let totalCost = 0;
		for (const [model, usage] of models) {
			const pricing = pricingByModel.get(model);
			if (pricing != null) {
				totalCost += calculateCodexCostUSD(usage, pricing);
			}
		}
		return {
			...row,
			totalCost,
			modelsUsed: Array.from(models.keys()).sort(compareStrings),
			metadata: { lastActivity, reasoningOutputTokens },
		};
	}).sort((a, b) => compareStrings(a.period, b.period));
}

async function loadOpenCodeRows(
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
): Promise<AllRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const entries = await loadOpenCodeMessages();
	const ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({ offline: options.offline === true, logger })
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher!;
	try {
		const groups = new Map<string, { row: AllRow; models: Set<string> }>();

		for (const entry of entries) {
			const date = formatDate(entry.timestamp.toISOString(), options.timezone);
			if (!isWithinRange(date, since, until)) {
				continue;
			}
			const period =
				kind === 'session' ? entry.sessionID : kind === 'monthly' ? date.slice(0, 7) : date;
			const group = groups.get(period) ?? {
				row: createEmptyRow(period, 'opencode'),
				models: new Set(),
			};
			if (!groups.has(period)) {
				groups.set(period, group);
			}
			group.row.inputTokens += entry.usage.inputTokens;
			group.row.outputTokens += entry.usage.outputTokens;
			group.row.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			group.row.cacheReadTokens += entry.usage.cacheReadInputTokens;
			group.row.totalTokens +=
				entry.usage.inputTokens +
				entry.usage.outputTokens +
				entry.usage.cacheCreationInputTokens +
				entry.usage.cacheReadInputTokens;
			group.row.totalCost += await calculateCostForEntry(entry, fetcher);
			group.models.add(entry.model);
		}

		return Array.from(groups.values(), ({ row, models }) => ({
			...row,
			modelsUsed: Array.from(models).sort(compareStrings),
		})).sort((a, b) => compareStrings(a.period, b.period));
	} finally {
		ownedFetcher?.[Symbol.dispose]();
	}
}

async function loadAmpRows(
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
): Promise<AllRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const { events } = await loadAmpUsageEvents();
	using pricingSource = new AmpPricingSource({
		fetcher: context.pricingFetcher,
		offline: options.offline,
	});
	const groups = new Map<string, { row: AllRow; models: Set<string>; credits: number }>();

	for (const event of events) {
		const date = formatDate(event.timestamp, options.timezone);
		if (!isWithinRange(date, since, until)) {
			continue;
		}
		const period =
			kind === 'session' ? event.threadId : kind === 'monthly' ? date.slice(0, 7) : date;
		const group = groups.get(period) ?? {
			row: createEmptyRow(period, 'amp'),
			models: new Set(),
			credits: 0,
		};
		if (!groups.has(period)) {
			groups.set(period, group);
		}
		group.row.inputTokens += event.inputTokens;
		group.row.outputTokens += event.outputTokens;
		group.row.cacheCreationTokens += event.cacheCreationInputTokens;
		group.row.cacheReadTokens += event.cacheReadInputTokens;
		group.row.totalTokens +=
			event.inputTokens +
			event.outputTokens +
			event.cacheCreationInputTokens +
			event.cacheReadInputTokens;
		group.row.totalCost += await pricingSource.calculateCost(event.model, {
			inputTokens: event.inputTokens,
			outputTokens: event.outputTokens,
			cacheCreationInputTokens: event.cacheCreationInputTokens,
			cacheReadInputTokens: event.cacheReadInputTokens,
		});
		group.credits += event.credits;
		group.models.add(event.model);
	}

	return Array.from(groups.values(), ({ row, models, credits }) => ({
		...row,
		modelsUsed: Array.from(models).sort(compareStrings),
		metadata: { credits },
	})).sort((a, b) => compareStrings(a.period, b.period));
}

async function loadPiRows(kind: ReportKind, options: AllOptions): Promise<AllRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const loaderOptions = {
		since,
		until,
		timezone: options.timezone,
		order: 'asc' as const,
	};

	if (kind === 'session') {
		const rows = await loadPiAgentSessionData(loaderOptions);
		return rows.map((row) => ({
			period: row.sessionId,
			agent: 'pi',
			modelsUsed: row.modelsUsed,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheCreationTokens: row.cacheCreationTokens,
			cacheReadTokens: row.cacheReadTokens,
			totalTokens:
				row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
			totalCost: row.totalCost,
			metadata: {
				lastActivity: row.lastActivity,
				projectPath: row.projectPath,
			},
		}));
	}

	if (kind === 'monthly') {
		const rows = await loadPiAgentMonthlyData(loaderOptions);
		return rows.map((row) => ({
			period: row.month,
			agent: 'pi',
			modelsUsed: row.modelsUsed,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheCreationTokens: row.cacheCreationTokens,
			cacheReadTokens: row.cacheReadTokens,
			totalTokens:
				row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
			totalCost: row.totalCost,
		}));
	}

	const rows = await loadPiAgentDailyData(loaderOptions);
	return rows.map((row) => ({
		period: row.date,
		agent: 'pi',
		modelsUsed: row.modelsUsed,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		cacheReadTokens: row.cacheReadTokens,
		totalTokens: row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
		totalCost: row.totalCost,
	}));
}

async function loadAgentRows(
	agent: AgentId,
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
): Promise<AllRow[]> {
	context.progress?.start(agent);
	try {
		const rows = await loadAgentRowsWithoutProgress(agent, kind, options, context);
		context.progress?.succeed(agent, rows.length);
		return rows;
	} catch (error) {
		context.progress?.fail(agent, error);
		throw error;
	}
}

async function loadAgentRowsWithoutProgress(
	agent: AgentId,
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
): Promise<AllRow[]> {
	switch (agent) {
		case 'claude':
			return loadClaudeRows(kind, options);
		case 'codex':
			return loadCodexRows(kind, options, context);
		case 'opencode':
			return loadOpenCodeRows(kind, options, context);
		case 'amp':
			return loadAmpRows(kind, options, context);
		case 'pi':
			return loadPiRows(kind, options);
	}
}

async function loadAllRowsWithContext(
	kind: ReportKind,
	options: AllOptions,
	context: AllLoadContext,
	agents = resolveAllAgents(options),
): Promise<AllRow[]> {
	const rows = (
		await Promise.all(agents.map(async (agent) => loadAgentRows(agent, kind, options, context)))
	).flat();
	if (kind === 'weekly') {
		return aggregateRowsByPeriod(rows, (row) => getDateStringWeek(row.period, 1));
	}
	if (kind === 'daily' || kind === 'monthly') {
		return aggregateRowsByPeriod(rows, (row) => row.period);
	}
	return rows.sort(
		(a, b) => compareStrings(a.period, b.period) || compareStrings(a.agent, b.agent),
	);
}

async function loadAllRows(
	kind: ReportKind,
	options: AllOptions,
	agents?: AgentId[],
	progress?: AllLoadProgress,
): Promise<AllRow[]> {
	if (options.offline === true) {
		return loadAllRowsWithContext(kind, options, { progress }, agents);
	}

	using pricingFetcher = new LiteLLMPricingFetcher({ logger });
	return await loadAllRowsWithContext(kind, options, { pricingFetcher, progress }, agents);
}

function calculateTotals(rows: AllRow[]): Omit<AllRow, 'period' | 'agent' | 'modelsUsed'> {
	return rows.reduce(
		(total, row) => {
			total.inputTokens += row.inputTokens;
			total.outputTokens += row.outputTokens;
			total.cacheCreationTokens += row.cacheCreationTokens;
			total.cacheReadTokens += row.cacheReadTokens;
			total.totalTokens += row.totalTokens;
			total.totalCost += row.totalCost;
			return total;
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
			totalCost: 0,
			metadata: undefined,
		},
	);
}

function formatDetectedAgentLabels(rows: AllRow[]): string {
	const detectedAgents = Array.from(new Set(rows.flatMap((row) => getRowAgents(row)))).sort(
		compareStrings,
	);
	return detectedAgents.map((agent) => agentLabels[agent]).join(', ');
}

function toJsonRows(rows: AllRow[]): AllRow[] {
	return rows.map(({ agentBreakdowns: _agentBreakdowns, ...row }) => row);
}

function shouldShowAllLoadProgress(options: AllOptions): boolean {
	return options.json !== true && process.stdout.isTTY === true;
}

function formatAllLoadProgressText(states: ReadonlyMap<AgentId, AllLoadProgressState>): string {
	if (states.size === 0) {
		return 'Loading usage logs';
	}
	const completed = Array.from(states.values()).filter((state) => state !== 'loading').length;
	const loadingAgents = Array.from(states.entries())
		.filter(([, state]) => state === 'loading')
		.map(([agent]) => agentLabels[agent])
		.join(', ');
	const suffix = loadingAgents === '' ? '' : ` :: ${loadingAgents}`;
	return `Loading usage logs (${completed}/${states.size})${suffix}`;
}

function createAllLoadProgress(enabled: boolean): AllLoadProgress | undefined {
	if (!enabled) {
		return undefined;
	}
	let spinner: Spinner | undefined;
	const states = new Map<AgentId, AllLoadProgressState>();

	function refresh(): void {
		spinner?.setText(formatAllLoadProgressText(states));
	}

	return {
		start(agent) {
			states.set(agent, 'loading');
			if (spinner == null) {
				spinner = new Spinner(formatAllLoadProgressText(states));
				spinner.start();
				return;
			}
			refresh();
		},
		succeed(agent) {
			states.set(agent, 'succeeded');
			refresh();
		},
		fail(agent) {
			states.set(agent, 'failed');
			refresh();
		},
		stop() {
			if (spinner?.running === true) {
				spinner.stop();
			}
			spinner = undefined;
			states.clear();
		},
	};
}

async function runAllReport(kind: ReportKind, options: AllOptions): Promise<void> {
	const originalLoggerLevel = logger.level;
	if (options.json === true) {
		logger.level = 0;
	}

	const title = `Coding Agent Usage Report - ${kind[0]!.toUpperCase()}${kind.slice(1)}`;
	let detectedAgents: AgentId[] | undefined;
	if (options.json !== true) {
		detectedAgents = await detectAllAgents(options);
		const detectedAgentLabels = detectedAgents
			.sort(compareStrings)
			.map((agent) => agentLabels[agent])
			.join(', ');
		logger.box(`${title}\nDetected: ${detectedAgentLabels === '' ? 'None' : detectedAgentLabels}`);
	}

	let rows: AllRow[];
	const progress = createAllLoadProgress(shouldShowAllLoadProgress(options));
	try {
		if (progress != null) {
			logger.level = 0;
		}
		rows = await loadAllRows(kind, options, detectedAgents, progress);
	} catch (error) {
		progress?.stop();
		logger.level = originalLoggerLevel;
		logger.error(String(error));
		process.exitCode = 1;
		return;
	} finally {
		logger.level = originalLoggerLevel;
	}
	progress?.stop();

	const totals = calculateTotals(rows);
	if (options.json === true) {
		await writeStdoutLine(
			JSON.stringify(
				{
					[kind]: toJsonRows(rows),
					totals,
				},
				null,
				2,
			),
		);
		return;
	}

	if (rows.length === 0) {
		logger.warn('No usage data found.');
		return;
	}

	const firstColumnName =
		kind === 'monthly'
			? 'Month'
			: kind === 'weekly'
				? 'Week'
				: kind === 'session'
					? 'Session'
					: 'Date';
	const table = createUsageReportTable({
		firstColumnName,
		includeAgent: true,
		dateFormatter: (dateStr: string) => formatDateCompact(dateStr, options.timezone),
		forceCompact: options.compact === true,
	});

	for (const row of rows) {
		table.push(
			formatUsageDataRow(row.period, {
				agent: row.agentBreakdowns == null ? agentLabels[row.agent] : 'All',
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheCreationTokens: row.cacheCreationTokens,
				cacheReadTokens: row.cacheReadTokens,
				totalCost: row.totalCost,
				modelsUsed: row.agentBreakdowns == null ? row.modelsUsed : [],
			}),
		);
		if (row.agentBreakdowns != null) {
			for (const breakdown of row.agentBreakdowns) {
				table.push(
					formatUsageDataRow('', {
						agent: `- ${agentLabels[breakdown.agent]}`,
						inputTokens: breakdown.inputTokens,
						outputTokens: breakdown.outputTokens,
						cacheCreationTokens: breakdown.cacheCreationTokens,
						cacheReadTokens: breakdown.cacheReadTokens,
						totalCost: breakdown.totalCost,
						modelsUsed: breakdown.modelsUsed,
					}),
				);
			}
		}
	}

	addEmptySeparatorRow(table, 9);
	table.push(
		formatTotalsRow(
			{
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
			},
			false,
			true,
		),
	);

	const renderedTable = table.toString();
	await writeStdoutLine(renderedTable);

	if (table.isCompactMode()) {
		await writeStdoutLine();
		logger.info('Running in Compact Mode');
		logger.info('Expand terminal width to see cache metrics and total tokens');
	}
}

function createAllCommand(kind: ReportKind, description: string): Command<typeof allArgs> {
	return define({
		name: kind,
		description,
		args: allArgs,
		toKebab: true,
		async run(ctx) {
			await runAllReport(kind, ctx.values);
		},
	});
}

export const allDailyCommand = createAllCommand(
	'daily',
	'Show all detected coding agent usage grouped by date',
);
export const allWeeklyCommand = createAllCommand(
	'weekly',
	'Show all detected coding agent usage grouped by week',
);
export const allMonthlyCommand = createAllCommand(
	'monthly',
	'Show all detected coding agent usage grouped by month',
);
export const allSessionCommand = createAllCommand(
	'session',
	'Show all detected coding agent usage grouped by session',
);

if (import.meta.vitest != null) {
	describe('resolveAllAgents', () => {
		it('defaults to all supported agents', () => {
			expect(resolveAllAgents({})).toEqual(['claude', 'codex', 'opencode', 'amp', 'pi']);
		});
	});

	describe('formatDetectedAgentLabels', () => {
		it('formats unique detected agents in stable order', () => {
			expect(
				formatDetectedAgentLabels([
					createEmptyRow('2026-01-01', 'codex'),
					createEmptyRow('2026-01-01', 'claude'),
					createEmptyRow('2026-01-02', 'codex'),
				]),
			).toBe('Claude, Codex');
		});
	});

	describe('aggregateRowsByPeriod', () => {
		it('groups same-day agent rows into one all row sorted by period', () => {
			const rows = aggregateRowsByPeriod(
				[
					{ ...createEmptyRow('2026-01-02', 'codex'), inputTokens: 10, modelsUsed: ['gpt-5'] },
					{
						...createEmptyRow('2026-01-01', 'amp'),
						outputTokens: 20,
						modelsUsed: ['claude-haiku-4-5-20251001'],
					},
					{
						...createEmptyRow('2026-01-02', 'opencode'),
						cacheReadTokens: 30,
						modelsUsed: ['claude-sonnet-4-20250514'],
					},
				],
				(row) => row.period,
			);

			expect(rows.map((row) => row.period)).toEqual(['2026-01-01', '2026-01-02']);
			expect(rows[1]).toEqual(
				expect.objectContaining({
					agent: 'all',
					inputTokens: 10,
					cacheReadTokens: 30,
					metadata: { agents: ['codex', 'opencode'] },
				}),
			);
		});
	});

	describe('shouldShowAllLoadProgress', () => {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

		afterEach(() => {
			if (descriptor == null) {
				delete (process.stdout as { isTTY?: boolean }).isTTY;
				return;
			}
			Object.defineProperty(process.stdout, 'isTTY', descriptor);
		});

		it('does not show progress in JSON mode even on a TTY', () => {
			Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

			expect(shouldShowAllLoadProgress({ json: true })).toBe(false);
		});

		it('shows progress only for table output on a TTY', () => {
			Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

			expect(shouldShowAllLoadProgress({ json: false })).toBe(true);
		});

		it('does not show progress when stdout is not a TTY', () => {
			Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

			expect(shouldShowAllLoadProgress({ json: false })).toBe(false);
		});
	});

	describe('formatAllLoadProgressText', () => {
		it('renders a single-line progress message for active agent loads', () => {
			expect(
				formatAllLoadProgressText(
					new Map<AgentId, AllLoadProgressState>([
						['claude', 'succeeded'],
						['codex', 'loading'],
						['opencode', 'loading'],
					]),
				),
			).toBe('Loading usage logs (1/3) :: Codex, OpenCode');
		});

		it('omits active labels once every load has completed', () => {
			expect(
				formatAllLoadProgressText(
					new Map<AgentId, AllLoadProgressState>([
						['claude', 'succeeded'],
						['codex', 'failed'],
					]),
				),
			).toBe('Loading usage logs (2/2)');
		});
	});
}
