/**
 * @fileoverview Daily usage command - daily breakdown across all services
 */

import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { createUsageReportTable, formatNumber, formatCurrency } from '@ccusage/terminal/table';
import { loadUnifiedDailyData } from '../data-loader.ts';

export const dailyCommand = define({
	meta: {
		description: 'Show daily usage across all AI services',
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
		const data = loadUnifiedDailyData();

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
		console.log(' │  AI Usage Report - Daily                   │');
		console.log(' │                                            │');
		console.log(' ╰────────────────────────────────────────────╯');
		console.log('');

		const table = createUsageReportTable({
			firstColumnName: 'Date',
		});

		// Group by date
		const byDate = new Map<string, typeof data>();
		for (const entry of data) {
			const existing = byDate.get(entry.date) ?? [];
			existing.push(entry);
			byDate.set(entry.date, existing);
		}

		let grandTotalTokens = 0;
		let grandTotalCost = 0;

		// Sort dates
		const sortedDates = Array.from(byDate.keys()).sort();

		for (const date of sortedDates) {
			const entries = byDate.get(date)!;

			// Aggregate for this date
			const dayTotal = {
				tokens: entries.reduce((sum, e) => sum + e.totalTokens, 0),
				input: entries.reduce((sum, e) => sum + e.inputTokens, 0),
				output: entries.reduce((sum, e) => sum + e.outputTokens, 0),
				cacheCreate: entries.reduce((sum, e) => sum + e.cacheCreateTokens, 0),
				cacheRead: entries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
				cost: entries.reduce((sum, e) => sum + e.cost, 0),
			};

			const services = entries.map(e => getServiceLabel(e.service)).join(', ');

			table.push([
				date,
				services,
				formatNumber(dayTotal.input),
				formatNumber(dayTotal.output),
				formatNumber(dayTotal.cacheCreate),
				formatNumber(dayTotal.cacheRead),
				formatNumber(dayTotal.tokens),
				formatCurrency(dayTotal.cost),
			]);

			grandTotalTokens += dayTotal.tokens;
			grandTotalCost += dayTotal.cost;
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
