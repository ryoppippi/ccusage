/**
 * @fileoverview Monthly usage command - aggregated by month across all services
 */

import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { createUsageReportTable, formatNumber, formatCurrency } from '@ccusage/terminal/table';
import { loadUnifiedMonthlyData } from '../data-loader.ts';

export const monthlyCommand = define({
	meta: {
		description: 'Show monthly usage across all AI services',
	},
	args: {
		json: {
			type: 'boolean',
			alias: 'j',
			description: 'Output report as JSON',
			default: false,
		},
	},
	run: async ({ args }) => {
		const data = loadUnifiedMonthlyData();

		if (data.length === 0) {
			console.log('');
			console.log(pc.yellow('No usage data found.'));
			return;
		}

		if (args.json) {
			process.stdout.write(JSON.stringify(data, null, 2));
			process.stdout.write('\n');
			return;
		}

		// Table output
		console.log('');
		console.log(' ╭────────────────────────────────────────────╮');
		console.log(' │                                            │');
		console.log(' │  AI Usage Report - Monthly                 │');
		console.log(' │                                            │');
		console.log(' ╰────────────────────────────────────────────╯');
		console.log('');

		const table = createUsageReportTable({
			firstColumnName: 'Month',
		});

		// Group by month
		const byMonth = new Map<string, typeof data>();
		for (const entry of data) {
			const existing = byMonth.get(entry.date) ?? [];
			existing.push(entry);
			byMonth.set(entry.date, existing);
		}

		let grandTotalTokens = 0;
		let grandTotalCost = 0;

		// Sort months
		const sortedMonths = Array.from(byMonth.keys()).sort();

		for (const month of sortedMonths) {
			const entries = byMonth.get(month)!;

			// Aggregate for this month
			const monthTotal = {
				tokens: entries.reduce((sum, e) => sum + e.totalTokens, 0),
				input: entries.reduce((sum, e) => sum + e.inputTokens, 0),
				output: entries.reduce((sum, e) => sum + e.outputTokens, 0),
				cacheCreate: entries.reduce((sum, e) => sum + e.cacheCreateTokens, 0),
				cacheRead: entries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
				cost: entries.reduce((sum, e) => sum + e.cost, 0),
			};

			const services = entries.map(e => getServiceLabel(e.service)).join(', ');

			table.push([
				month,
				services,
				formatNumber(monthTotal.input),
				formatNumber(monthTotal.output),
				formatNumber(monthTotal.cacheCreate),
				formatNumber(monthTotal.cacheRead),
				formatNumber(monthTotal.tokens),
				formatCurrency(monthTotal.cost),
			]);

			grandTotalTokens += monthTotal.tokens;
			grandTotalCost += monthTotal.cost;
		}

		// Add total
		table.push([
			pc.yellow('Total'),
			'',
			'', '', '', '', // Skip token breakdowns
			pc.yellow(formatNumber(grandTotalTokens)),
			pc.yellow(formatCurrency(grandTotalCost)),
		]);

		console.log(table.toString());
		console.log('');
	},
});

function getServiceLabel(service: string): string {
	const labels: Record<string, string> = {
		'claude': 'Claude',
		'codex': 'Codex',
		'cursor': 'Cursor',
		'copilot': 'Copilot',
	};
	return labels[service] ?? service;
}
