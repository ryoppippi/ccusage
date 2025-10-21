/**
 * @fileoverview Dashboard command - unified view of all AI services
 */

import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { createUsageReportTable, formatNumber, formatCurrency } from '@ccusage/terminal/table';
import { checkServiceAvailability, loadUnifiedMonthlyData } from '../data-loader.ts';
import { logger } from '../logger.ts';
import type { AIService } from '../types.ts';

export const dashboardCommand = define({
	meta: {
		description: 'Show unified dashboard of all AI services usage',
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
		logger.info('Checking AI service availability...');
		const statuses = await checkServiceAvailability();

		const availableServices = statuses.filter(s => s.available);
		const unavailableServices = statuses.filter(s => !s.available);

		if (args.json) {
			// JSON output
			const data = loadUnifiedMonthlyData();

			// Aggregate by service
			const byService: Record<string, { tokens: number; cost: number }> = {};
			for (const entry of data) {
				if (!byService[entry.service]) {
					byService[entry.service] = { tokens: 0, cost: 0 };
				}
				byService[entry.service].tokens += entry.totalTokens;
				byService[entry.service].cost += entry.cost;
			}

			const output = {
				services: statuses,
				usage: byService,
				total: {
					tokens: data.reduce((sum, e) => sum + e.totalTokens, 0),
					cost: data.reduce((sum, e) => sum + e.cost, 0),
				},
			};

			process.stdout.write(JSON.stringify(output, null, 2));
			process.stdout.write('\n');
			return;
		}

		// Table output
		console.log('');
		console.log(' ╭────────────────────────────────────────────╮');
		console.log(' │                                            │');
		console.log(' │  AI Usage Dashboard - All Services         │');
		console.log(' │                                            │');
		console.log(' ╰────────────────────────────────────────────╯');
		console.log('');

		// Show service availability
		console.log(pc.bold('Available Services:'));
		for (const status of availableServices) {
			console.log(`  ${pc.green('✓')} ${getServiceName(status.service)} ${pc.gray(`(${status.dataPath})`)}`);
		}

		if (unavailableServices.length > 0) {
			console.log('');
			console.log(pc.bold('Unavailable Services:'));
			for (const status of unavailableServices) {
				console.log(`  ${pc.red('✗')} ${getServiceName(status.service)} ${pc.gray(`- ${status.error}`)}`);
			}
		}

		if (availableServices.length === 0) {
			console.log('');
			console.log(pc.yellow('No AI services with data found.'));
			console.log('');
			console.log('Install and use one of these AI coding assistants:');
			console.log('  • Claude Code: https://claude.ai/code');
			console.log('  • OpenAI Codex CLI: https://github.com/openai/codex');
			console.log('  • Cursor AI: https://cursor.com');
			console.log('  • GitHub Copilot: https://github.com/features/copilot');
			console.log('');
			return;
		}

		// Load and display usage data
		const data = loadUnifiedMonthlyData();

		if (data.length === 0) {
			console.log('');
			console.log(pc.yellow('No usage data found.'));
			return;
		}

		// Aggregate by service
		const byService = new Map<AIService, { tokens: number; cost: number }>();
		for (const entry of data) {
			const existing = byService.get(entry.service) ?? { tokens: 0, cost: 0 };
			existing.tokens += entry.totalTokens;
			existing.cost += entry.cost;
			byService.set(entry.service, existing);
		}

		console.log('');
		console.log(pc.bold('Total Usage (All Time):'));
		console.log('');

		// Create summary table
		const table = createUsageReportTable({
			firstColumnName: 'Service',
			forceCompact: true,
		});

		let totalTokens = 0;
		let totalCost = 0;

		for (const [service, stats] of byService.entries()) {
			table.push([
				getServiceName(service),
				'', // Models column (empty for summary)
				formatNumber(stats.tokens),
				'', // Output (not broken down)
				formatCurrency(stats.cost),
			]);
			totalTokens += stats.tokens;
			totalCost += stats.cost;
		}

		// Add total row
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totalTokens)),
			'',
			pc.yellow(formatCurrency(totalCost)),
		]);

		console.log(table.toString());
		console.log('');
		console.log(pc.gray('💡 Tip: Use `aiusage monthly` or `aiusage daily` for detailed breakdowns'));
		console.log('');
	},
});

/**
 * Get friendly service name
 */
function getServiceName(service: AIService): string {
	switch (service) {
		case 'claude':
			return 'Claude Code';
		case 'codex':
			return 'OpenAI Codex CLI';
		case 'cursor':
			return 'Cursor AI';
		case 'copilot':
			return 'GitHub Copilot';
		default:
			return service;
	}
}
