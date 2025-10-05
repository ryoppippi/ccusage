import type { PricingSource, TokenUsageEvent } from './_types.ts';
import type { CodexBlockSummary } from './block-calculator.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import pc from 'picocolors';
import { convertEventsToBlockEntries } from './_block-entry.ts';
import { DEFAULT_SESSION_DURATION_HOURS, identifyCodexSessionBlocks } from './_session-blocks.ts';
import { buildCodexBlocksReport } from './block-calculator.ts';
import { formatModelsList } from './command-utils.ts';
import { formatBlockTime } from './commands/blocks.ts';
import { loadTokenUsageEvents } from './data-loader.ts';
import { log, logger } from './logger.ts';
import { CodexPricingSource } from './pricing.ts';

export type CodexLiveMonitorConfig = {
	codexPaths: string[];
	sessionDurationHours: number;
	tokenLimit?: number;
	refreshIntervalMs: number;
	offline?: boolean;
	pricingSource?: PricingSource;
};

export type LiveSnapshot = {
	blocks: CodexBlockSummary[];
};

export async function generateLiveSnapshot(
	events: TokenUsageEvent[],
	config: CodexLiveMonitorConfig,
): Promise<LiveSnapshot> {
	if (events.length === 0) {
		return { blocks: [] };
	}

	const entries = convertEventsToBlockEntries(events);
	const blocks = identifyCodexSessionBlocks(entries, config.sessionDurationHours);

	let targets = blocks.filter(block => block.isActive);
	if (targets.length === 0 && blocks.length > 0) {
		targets = [blocks.at(-1)!];
	}

	if (targets.length === 0) {
		return { blocks: [] };
	}

	if (config.pricingSource != null) {
		const report = await buildCodexBlocksReport({
			blocks: targets,
			pricingSource: config.pricingSource,
			tokenLimit: config.tokenLimit,
		});
		return { blocks: report.blocks };
	}

	using pricingSource = new CodexPricingSource({ offline: config.offline });
	const report = await buildCodexBlocksReport({
		blocks: targets,
		pricingSource,
		tokenLimit: config.tokenLimit,
	});
	return { blocks: report.blocks };
}

export async function startCodexLiveMonitor(
	config: CodexLiveMonitorConfig,
	abortSignal: AbortSignal,
): Promise<void> {
	const refreshInterval = Math.min(Math.max(config.refreshIntervalMs, 1_000), 60_000);
	const pricingSource = config.pricingSource ?? new CodexPricingSource({ offline: config.offline });
	const disposePricing = config.pricingSource == null;

	const cleanup = () => {
		if (disposePricing) {
			(pricingSource as CodexPricingSource)[Symbol.dispose]();
		}
	};

	try {
		while (!abortSignal.aborted) {
			const loadOptions = config.codexPaths.length > 0 ? { sessionDirs: config.codexPaths } : undefined;
			const { events, missingDirectories } = await loadTokenUsageEvents(loadOptions);

			process.stdout.write('\u001Bc');
			logger.box('Codex Blocks Live Monitor');
			if (missingDirectories.length > 0) {
				for (const missing of missingDirectories) {
					logger.warn(`Codex session directory not found: ${missing}`);
				}
			}

			const snapshot = await generateLiveSnapshot(events, {
				...config,
				pricingSource,
			});

			if (snapshot.blocks.length === 0) {
				log('No active blocks detected. Waiting for new activity...');
			}
			else {
				displayLiveTable(snapshot.blocks, config.tokenLimit);
			}

			if (abortSignal.aborted) {
				break;
			}

			await new Promise(resolve => setTimeout(resolve, refreshInterval));
		}
	}
	finally {
		cleanup();
	}
}

const LIVE_TABLE_COLUMNS = 6;

function displayLiveTable(blocks: CodexBlockSummary[], tokenLimit?: number): void {
	const table = new ResponsiveTable({
		head: ['Window', 'Models', 'Tokens', 'Cost (USD)', 'Burn Rate (tokens/min)', 'Status'],
		colAligns: ['left', 'left', 'right', 'right', 'right', 'left'],
		compactHead: ['Window', 'Tokens', 'Cost', 'Status'],
		compactColAligns: ['left', 'right', 'right', 'left'],
		compactThreshold: 80,
		forceCompact: false,
		style: { head: ['magenta'] },
	});

	for (const summary of blocks) {
		const models = formatModelsList(Object.fromEntries(Object.entries(summary.models).map(([model, usage]) => [
			model,
			{ totalTokens: usage.totalTokens, isFallback: usage.isFallback },
		])));

		const burnRate = summary.burnRate != null
			? `${formatNumber(Math.round(summary.burnRate.tokensPerMinute))}`
			: '-';

		const statusParts: string[] = [];
		if (summary.block.isActive === true) {
			statusParts.push(pc.cyan('ACTIVE'));
		}
		if (summary.block.isGap === true) {
			statusParts.push(pc.gray('GAP'));
		}
		if (summary.tokenLimitStatus === 'warning') {
			statusParts.push(pc.yellow('⚠️ nearing limit'));
		}
		if (summary.tokenLimitStatus === 'exceeds') {
			statusParts.push(pc.red('🔥 limit exceeded'));
		}
		if (summary.projection != null && tokenLimit != null && summary.projection.totalTokens >= tokenLimit) {
			statusParts.push(pc.red('projection over limit'));
		}

		table.push([
			formatBlockTime(summary.block, table.isCompactMode()),
			table.isCompactMode() ? '' : models.join('\n'),
			formatNumber(summary.block.tokenCounts.totalTokens),
			formatCurrency(summary.block.costUSD),
			burnRate,
			statusParts.join(' '),
		]);
	}

	addEmptySeparatorRow(table, LIVE_TABLE_COLUMNS);
	log(table.toString());
}

if (import.meta.vitest != null) {
	describe('generateLiveSnapshot', () => {
		it('builds a summary for active blocks', async () => {
			const now = new Date();
			const events: TokenUsageEvent[] = [
				{
					sessionId: 'session-1',
					timestamp: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
					model: 'gpt-5',
					inputTokens: 200,
					cachedInputTokens: 50,
					outputTokens: 100,
					reasoningOutputTokens: 0,
					totalTokens: 300,
				},
			];

			const pricingSource: PricingSource = {
				async getPricing() {
					return { inputCostPerMToken: 1, cachedInputCostPerMToken: 0.5, outputCostPerMToken: 2 };
				},
			};

			const snapshot = await generateLiveSnapshot(events, {
				codexPaths: [],
				sessionDurationHours: DEFAULT_SESSION_DURATION_HOURS,
				refreshIntervalMs: 1_000,
				tokenLimit: 1_000,
				pricingSource,
			});

			expect(snapshot.blocks).toHaveLength(1);
			const summary = snapshot.blocks[0]!;
			expect(summary.block.isActive || summary.block.isGap).toBe(true);
			expect(summary.tokenLimitStatus).toBeDefined();
		});
	});
}
