import type { CombinedTotals, Source } from '../_types.ts';
import { formatCurrency, formatNumber } from '@ccusage/terminal/table';
import { CODEX_CACHE_MARK, SOURCE_COLORS, SOURCE_LABELS } from '../_consts.ts';
import { Sources } from '../_types.ts';

export function formatSourceLabel(source: Source): string {
	return SOURCE_COLORS[source](SOURCE_LABELS[source]);
}

export function formatSourcesTitle(sources: Source[]): string {
	if (sources.length === 0 || sources.length === Sources.length) {
		return 'All Sources';
	}

	return sources.map((source) => SOURCE_LABELS[source]).join(', ');
}

export function formatCacheValue(source: Source, cacheTokens: number): string {
	const value = formatNumber(cacheTokens);
	return source === 'codex' ? `${value}${CODEX_CACHE_MARK}` : value;
}

export function formatCostSummary(totals: CombinedTotals): string {
	const labels = totals.bySource.map((entry) => SOURCE_LABELS[entry.source]);
	const labelWidth = Math.max('TOTAL'.length, ...labels.map((label) => label.length));
	const dotWidth = Math.max(8, labelWidth + 8);

	const lines: string[] = ['By Source (Cost)'];
	for (const entry of totals.bySource) {
		const label = SOURCE_LABELS[entry.source];
		const dots = '.'.repeat(Math.max(2, dotWidth - label.length));
		lines.push(`  - ${label} ${dots} ${formatCurrency(entry.costUSD)}`);
	}

	const totalDots = '.'.repeat(Math.max(2, dotWidth - 'TOTAL'.length));
	lines.push(`  TOTAL ${totalDots} ${formatCurrency(totals.costUSD)}`);

	return lines.join('\n');
}
