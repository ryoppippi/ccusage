import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import { calculateCostForEntry } from '../cost-utils';
import { loadOpenCodeMessages } from '../data-loader';

const TABLE_COLUMN_COUNT = 8;

/**
 * Get ISO week number for a date
 * ISO week starts on Monday, first week contains Jan 4th
 * @param date - Date to get ISO week for
 * @returns Week string in format YYYY-Www (e.g., "2025-W51")
 */
function getISOWeek(date: Date): string {
	// Copy date to avoid mutating original
	const d = new Date(date.getTime());

	// Set to nearest Thursday: current date + 4 - current day number
	// Make Sunday's day number 7
	const dayNum = d.getDay() || 7;
	d.setDate(d.getDate() + 4 - dayNum);

	// Get first day of year
	const yearStart = new Date(d.getFullYear(), 0, 1);

	// Calculate full weeks to nearest Thursday
	const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

	// Return formatted string
	return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export const weeklyCommand = define({
	name: 'weekly',
	description: 'Show OpenCode token usage grouped by week (ISO week format)',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
		},
		compact: {
			type: 'boolean',
			description: 'Force compact table mode',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);

		const entries = await loadOpenCodeMessages();

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ weekly: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false });

		const entriesByWeek = groupBy(entries, (entry) => getISOWeek(entry.timestamp));

		const weeklyData: Array<{
			week: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
		}> = [];

		for (const [week, weekEntries] of Object.entries(entriesByWeek)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();

			for (const entry of weekEntries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += await calculateCostForEntry(entry, fetcher);
				modelsSet.add(entry.model);
			}

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			weeklyData.push({
				week,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
			});
		}

		weeklyData.sort((a, b) => a.week.localeCompare(b.week));

		const totals = {
			inputTokens: weeklyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: weeklyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: weeklyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: weeklyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalTokens: weeklyData.reduce((sum, d) => sum + d.totalTokens, 0),
			totalCost: weeklyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						weekly: weeklyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Weekly\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Week',
				'Models',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Week', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of weeklyData) {
			table.push([
				data.week,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheCreationTokens),
				formatNumber(data.cacheReadTokens),
				formatNumber(data.totalTokens),
				formatCurrency(data.totalCost),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheCreationTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache metrics and total tokens');
		}
	},
});

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('getISOWeek', () => {
		it('should get ISO week for a date in the middle of the year', () => {
			const date = new Date('2025-06-15T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2025-W24');
		});

		it('should handle year boundary correctly', () => {
			// Dec 29, 2025 is a Monday (first week of 2026 in ISO)
			const date = new Date('2025-12-29T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2026-W01');
		});

		it('should handle first week of year', () => {
			// Jan 5, 2025 is a Sunday (week 1 of 2025)
			const date = new Date('2025-01-05T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2025-W01');
		});

		it('should handle last days of previous year belonging to week 1', () => {
			// Jan 1, 2025 is a Wednesday (week 1 of 2025)
			const date = new Date('2025-01-01T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2025-W01');
		});
	});
}
