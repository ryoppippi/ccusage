import type { AdapterOptions, AgentUsageRow, ReportKind } from '../types.ts';
import process from 'node:process';
import { hasFileRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { normalizeDateFilter, toCompactDate } from '../shared.ts';
import { loadDailyUsageData, loadMonthlyUsageData, loadSessionData } from './data-loader.ts';
import { getClaudeProjectPaths } from './paths.ts';

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return hasFileRecursive(root, { extension });
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

if (import.meta.vitest != null) {
	describe('loadClaudeRows', () => {
		it.skipIf(process.env.CI === 'true' || !getClaudeProjectPaths().some(isDirectorySyncSafe))(
			'loads local Claude usage rows when the user has a projects directory',
			async () => {
				const rows = await loadClaudeRows('daily', {
					offline: true,
					timezone: 'UTC',
				});

				expect(rows.length).toBeGreaterThan(0);
			},
			30_000,
		);
	});
}
