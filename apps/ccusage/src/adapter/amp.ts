import type { AdapterContext, AdapterOptions, AgentUsageRow, ReportKind } from './types.ts';
import path from 'node:path';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import { getAmpPath, loadAmpUsageEvents } from '../../../amp/src/data-loader.ts';
import { AmpPricingSource } from '../../../amp/src/pricing.ts';
import { createEmptyRow, formatDateKey, isWithinRange, normalizeDateFilter } from './shared.ts';

async function hasFiles(root: string, extension: `.${string}`): Promise<boolean> {
	return (await collectFilesRecursive(root, { extension })).length > 0;
}

export async function detectAmp(): Promise<boolean> {
	const ampPath = getAmpPath();
	return ampPath != null && (await hasFiles(path.join(ampPath, 'threads'), '.json'));
}

export async function loadAmpRows(
	kind: ReportKind,
	options: AdapterOptions,
	context: AdapterContext,
): Promise<AgentUsageRow[]> {
	const since = normalizeDateFilter(options.since);
	const until = normalizeDateFilter(options.until);
	const { events } = await loadAmpUsageEvents();
	using pricingSource = new AmpPricingSource({
		fetcher: context.pricingFetcher,
		offline: options.offline,
	});
	const groups = new Map<string, { row: AgentUsageRow; models: Set<string>; credits: number }>();

	for (const event of events) {
		const date = formatDateKey(event.timestamp, options.timezone);
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
