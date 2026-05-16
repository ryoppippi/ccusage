import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from './types.ts';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { compareStrings } from '@ccusage/internal/sort';
import { calculateCostForEntry } from '../../../opencode/src/cost-utils.ts';
import { getOpenCodePath, loadOpenCodeMessages } from '../../../opencode/src/data-loader.ts';
import { logger } from '../logger.ts';
import { createEmptyRow, formatDateKey, isWithinRange, normalizeDateFilter } from './shared.ts';

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

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return (await collectFilesRecursive(root, { extension })).length > 0;
}

export async function detectOpenCode(): Promise<boolean> {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return false;
	}
	return (
		hasOpenCodeDatabase(openCodePath) ||
		(await hasFiles(path.join(openCodePath, 'storage', 'message'), '.json'))
	);
}

export async function loadOpenCodeRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const entries = await loadOpenCodeMessages();
	const ownedFetcher =
		context.pricingFetcher == null
			? new LiteLLMPricingFetcher({ offline: options.offline === true, logger })
			: undefined;
	const fetcher = context.pricingFetcher ?? ownedFetcher!;
	try {
		const groups = new Map<string, { row: AgentUsageRow; models: Set<string> }>();

		for (const entry of entries) {
			const date = formatDateKey(entry.timestamp.toISOString(), options.timezone);
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
