import type { AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { loadDailyUsageData, loadMonthlyUsageData, loadSessionData } from '../../data-loader.ts';
import { normalizeDateFilter, toCompactDate } from '../shared.ts';
import { getClaudeProjectPaths } from './paths.ts';

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return (await collectFilesRecursive(root, { extension })).length > 0;
}

export async function detectClaude(): Promise<boolean> {
	const results = await Promise.all(
		getClaudeProjectPaths().map(async (projectsPath) => hasFiles(projectsPath, '.jsonl')),
	);
	return results.some(Boolean);
}

export async function loadClaudeRows(
	kind: ReportKind,
	options: AdapterOptions,
): Promise<AgentUsageRow[]> {
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
