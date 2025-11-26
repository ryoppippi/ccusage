import type { CostMode } from '../_types.ts';
import type { UsageData } from '../data-loader.ts';
import process from 'node:process';
import { formatCurrency, formatNumber, ResponsiveTable } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import pc from 'picocolors';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { loadSessionUsageById } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

export type SessionIdContext = {
	values: {
		id: string;
		mode: CostMode;
		offline: boolean;
		jq?: string;
		timezone?: string;
		locale: string; // normalized to non-optional to avoid touching data-loader
	};
};

/**
 * Handles the session ID lookup and displays usage data.
 */
export async function handleSessionIdLookup(ctx: SessionIdContext, useJson: boolean): Promise<void> {
	const sessionUsage = await loadSessionUsageById(ctx.values.id, {
		mode: ctx.values.mode,
		offline: ctx.values.offline,
	});

	if (sessionUsage == null) {
		if (useJson) {
			log(JSON.stringify(null));
		}
		else {
			logger.warn(`No session found with ID: ${ctx.values.id}`);
		}
		process.exit(0);
	}

	if (useJson) {
		const jsonOutput = {
			sessionId: ctx.values.id,
			totalCost: sessionUsage.totalCost,
			totalTokens: calculateSessionTotalTokens(sessionUsage.entries),
			entries: sessionUsage.entries.map(entry => ({
				timestamp: entry.timestamp,
				inputTokens: entry.message.usage.input_tokens,
				outputTokens: entry.message.usage.output_tokens,
				cacheCreationTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
				cacheReadTokens: entry.message.usage.cache_read_input_tokens ?? 0,
				model: entry.message.model ?? 'unknown',
				costUSD: entry.costUSD ?? 0,
				...(entry.isSidechain === true && { isSubagent: true }),
			})),
		};

		if (ctx.values.jq != null) {
			const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
			if (Result.isFailure(jqResult)) {
				logger.error(jqResult.error.message);
				process.exit(1);
			}
			log(jqResult.value);
		}
		else {
			log(JSON.stringify(jsonOutput, null, 2));
		}
	}
	else {
		logger.box(`Claude Code Session Usage - ${ctx.values.id}`);

		const totalTokens = calculateSessionTotalTokens(sessionUsage.entries);

		// Calculate subagent summary
		const subagentEntries = sessionUsage.entries.filter(entry => entry.isSidechain === true);
		const hasSubagents = subagentEntries.length > 0;

		log(`Total Cost: ${formatCurrency(sessionUsage.totalCost)}`);
		log(`Total Tokens: ${formatNumber(totalTokens)}`);
		log(`Total Entries: ${sessionUsage.entries.length}`);
		// Note: session --id is a detail command, so we always show subagent count in header
		if (hasSubagents) {
			log(`Subagent Tasks: ${subagentEntries.length}`);
		}
		log('');

		if (sessionUsage.entries.length > 0) {
			const table = new ResponsiveTable({
				head: [
					'Timestamp',
					'Model',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Cost (USD)',
				],
				style: { head: ['cyan'] },
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
			});

			for (const entry of sessionUsage.entries) {
				const modelName = entry.message.model ?? 'unknown';
				const isSubagent = entry.isSidechain === true;
				const displayModel = isSubagent ? `[subagent] ${modelName}` : modelName;

				table.push([
					formatDateCompact(entry.timestamp, ctx.values.timezone, ctx.values.locale),
					displayModel,
					formatNumber(entry.message.usage.input_tokens),
					formatNumber(entry.message.usage.output_tokens),
					formatNumber(entry.message.usage.cache_creation_input_tokens ?? 0),
					formatNumber(entry.message.usage.cache_read_input_tokens ?? 0),
					formatCurrency(entry.costUSD ?? 0),
				]);
			}

			log(table.toString());

			// Show subagent summary if there are subagents (session --id always shows detail)
			if (hasSubagents) {
				const subagentStats = calculateSubagentStats(subagentEntries);
				log('');
				log(pc.cyan(pc.bold('Subagent Usage Summary:')));
				log(`  Tasks Executed:   ${subagentStats.count}`);
				log(`  Input Tokens:     ${formatNumber(subagentStats.inputTokens)}`);
				log(`  Output Tokens:    ${formatNumber(subagentStats.outputTokens)}`);
				log(`  Total Tokens:     ${formatNumber(subagentStats.totalTokens)}`);
				log(`  Total Cost:       ${formatCurrency(subagentStats.totalCost)}`);
			}
		}
	}
}

function calculateSessionTotalTokens(entries: UsageData[]): number {
	return entries.reduce((sum, entry) => {
		const usage = entry.message.usage;
		return (
			sum
			+ usage.input_tokens
			+ usage.output_tokens
			+ (usage.cache_creation_input_tokens ?? 0)
			+ (usage.cache_read_input_tokens ?? 0)
		);
	}, 0);
}

function calculateSubagentStats(entries: UsageData[]): {
	count: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	totalCost: number;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let totalCost = 0;

	for (const entry of entries) {
		const usage = entry.message.usage;
		inputTokens += usage.input_tokens;
		outputTokens += usage.output_tokens;
		totalCost += entry.costUSD ?? 0;
	}

	const totalTokens = entries.reduce((sum, entry) => {
		const usage = entry.message.usage;
		return (
			sum
			+ usage.input_tokens
			+ usage.output_tokens
			+ (usage.cache_creation_input_tokens ?? 0)
			+ (usage.cache_read_input_tokens ?? 0)
		);
	}, 0);

	return {
		count: entries.length,
		inputTokens,
		outputTokens,
		totalTokens,
		totalCost,
	};
}

if (import.meta.vitest != null) {
	describe('calculateSubagentStats', () => {
		it('calculates stats correctly for subagent entries', () => {
			const entries = [
				{
					timestamp: '2024-01-01T00:00:00Z',
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 10,
							cache_read_input_tokens: 20,
						},
					},
					costUSD: 0.5,
					isSidechain: true,
				},
				{
					timestamp: '2024-01-01T00:01:00Z',
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 50,
						},
					},
					costUSD: 0.3,
					isSidechain: true,
				},
			] as unknown as UsageData[];

			const stats = calculateSubagentStats(entries);

			expect(stats.count).toBe(2);
			expect(stats.inputTokens).toBe(300);
			expect(stats.outputTokens).toBe(150);
			expect(stats.totalTokens).toBe(530); // 300 + 150 + 10 + 20 + 0 + 50
			expect(stats.totalCost).toBe(0.8);
		});

		it('handles empty entries array', () => {
			const stats = calculateSubagentStats([] as unknown as UsageData[]);

			expect(stats.count).toBe(0);
			expect(stats.inputTokens).toBe(0);
			expect(stats.outputTokens).toBe(0);
			expect(stats.totalTokens).toBe(0);
			expect(stats.totalCost).toBe(0);
		});

		it('handles entries without cache tokens', () => {
			const entries = [
				{
					timestamp: '2024-01-01T00:00:00Z',
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					costUSD: 0.5,
					isSidechain: true,
				},
			] as unknown as UsageData[];

			const stats = calculateSubagentStats(entries);

			expect(stats.count).toBe(1);
			expect(stats.inputTokens).toBe(100);
			expect(stats.outputTokens).toBe(50);
			expect(stats.totalTokens).toBe(150);
			expect(stats.totalCost).toBe(0.5);
		});

		it('handles entries with null costUSD', () => {
			const entries = [
				{
					timestamp: '2024-01-01T00:00:00Z',
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					costUSD: null,
					isSidechain: true,
				},
			] as unknown as UsageData[];

			const stats = calculateSubagentStats(entries);

			expect(stats.count).toBe(1);
			expect(stats.totalCost).toBe(0);
		});
	});
}
