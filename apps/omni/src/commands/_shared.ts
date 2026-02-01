import type { CombinedTotals, Source, UnifiedModelBreakdown } from '../_types.ts';
import { formatCurrency, formatNumber } from '@ccusage/terminal/table';
import pc from 'picocolors';
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

/**
 * Shortens model names for display in breakdown rows
 */
export function formatModelNameShort(modelName: string): string {
	// Handle [pi] prefix - preserve prefix, format the rest
	const piMatch = modelName.match(/^\[pi\] (.+)$/);
	if (piMatch?.[1] != null) {
		return `[pi] ${formatModelNameShort(piMatch[1])}`;
	}

	// Handle claude- with date suffix (e.g., "claude-sonnet-4-5-20250929" -> "sonnet-4-5")
	const match = modelName.match(/^claude-(\w+)-([\d-]+)-(\d{8})$/);
	if (match != null) {
		return `${match[1]}-${match[2]}`;
	}

	// Handle claude- without date suffix (e.g., "claude-opus-4-5" -> "opus-4-5")
	const noDateMatch = modelName.match(/^claude-(\w+)-([\d-]+)$/);
	if (noDateMatch != null) {
		return `${noDateMatch[1]}-${noDateMatch[2]}`;
	}

	// Return original if pattern doesn't match
	return modelName;
}

/**
 * Pushes breakdown rows to a table for per-model details
 */
export function pushBreakdownRows(
	table: { push: (row: (string | number)[]) => void },
	breakdowns: UnifiedModelBreakdown[],
	columnCount: number,
): void {
	for (const breakdown of breakdowns) {
		const cacheTokens = breakdown.cacheReadTokens + breakdown.cacheCreationTokens;
		const row: (string | number)[] = [
			`  └─ ${formatModelNameShort(breakdown.modelName)}`,
			'',
			pc.gray(formatNumber(breakdown.inputTokens)),
			pc.gray(formatNumber(breakdown.outputTokens)),
			pc.gray(formatNumber(cacheTokens)),
			pc.gray(formatCurrency(breakdown.cost)),
		];
		// Add empty columns to match table width
		while (row.length < columnCount) {
			row.push('');
		}
		table.push(row);
	}
}
