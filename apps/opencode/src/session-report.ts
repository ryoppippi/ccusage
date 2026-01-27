import type { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedSessionMetadata, LoadedUsageEntry } from './data-loader.ts';
import { groupBy } from 'es-toolkit';
import { calculateCostForEntry } from './cost-utils.ts';

export type SessionReportRow = {
	sessionID: string;
	sessionTitle: string;
	parentID: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
	lastActivity: string; // ISO timestamp
};

export type SessionReportOptions = {
	pricingFetcher: LiteLLMPricingFetcher;
	sessionMetadata?: Map<string, LoadedSessionMetadata>;
};

export async function buildSessionReport(
	entries: LoadedUsageEntry[],
	options: SessionReportOptions,
): Promise<SessionReportRow[]> {
	const entriesBySession = groupBy(entries, (entry) => entry.sessionID);
	const sessionMetadata = options.sessionMetadata ?? new Map<string, LoadedSessionMetadata>();

	const sessionData: SessionReportRow[] = [];

	for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		let totalCost = 0;
		const modelsSet = new Set<string>();
		let lastActivity = sessionEntries[0]!.timestamp;

		for (const entry of sessionEntries) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
			cacheCreationTokens += entry.usage.cacheCreationInputTokens;
			cacheReadTokens += entry.usage.cacheReadInputTokens;
			totalCost += await calculateCostForEntry(entry, options.pricingFetcher);
			modelsSet.add(entry.model);

			if (entry.timestamp > lastActivity) {
				lastActivity = entry.timestamp;
			}
		}

		const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
		const metadata = sessionMetadata.get(sessionID);

		sessionData.push({
			sessionID,
			sessionTitle: metadata?.title ?? sessionID,
			parentID: metadata?.parentID ?? null,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			totalTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
			lastActivity: lastActivity.toISOString(),
		});
	}

	sessionData.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));

	return sessionData;
}
