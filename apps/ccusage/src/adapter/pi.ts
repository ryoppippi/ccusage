import type { AdapterOptions, AgentUsageRow, ReportKind } from './types.ts';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { getPiAgentPaths } from '../../../pi/src/_pi-agent.ts';
import {
	loadPiAgentDailyData,
	loadPiAgentMonthlyData,
	loadPiAgentSessionData,
} from '../../../pi/src/data-loader.ts';
import { normalizeDateFilter } from './shared.ts';

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return (await collectFilesRecursive(root, { extension })).length > 0;
}

export async function detectPi(): Promise<boolean> {
	const results = await Promise.all(
		getPiAgentPaths().map(async (sessionsPath) => hasFiles(sessionsPath, '.jsonl')),
	);
	return results.some(Boolean);
}

export async function loadPiRows(
	kind: ReportKind,
	options: AdapterOptions,
): Promise<AgentUsageRow[]> {
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
