import process from 'node:process';
import Table from 'cli-table3';
import { define } from 'gunshi';
import pc from 'picocolors';
import { getDefaultClaudePath, loadFiveHourBlockData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import { formatCurrency, formatNumber } from '../utils.internal.ts';
import {
	calculateBurnRate,
	filterRecentBlocks,
	type FiveHourBlock,
	projectBlockUsage,
} from '../utils/five-hour-blocks.ts';

function formatBlockTime(block: FiveHourBlock): string {
	const start = block.startTime.toLocaleString();
	if (block.isGap) {
		const end = block.endTime.toLocaleString();
		const duration = Math.round((block.endTime.getTime() - block.startTime.getTime()) / (1000 * 60 * 60));
		return `${start} - ${end} (${duration}h gap)`;
	}

	const duration = block.actualEndTime
		? Math.round((block.actualEndTime.getTime() - block.startTime.getTime()) / (1000 * 60))
		: 0;

	if (block.isActive) {
		const now = new Date();
		const elapsed = Math.round((now.getTime() - block.startTime.getTime()) / (1000 * 60));
		const remaining = Math.round((block.endTime.getTime() - now.getTime()) / (1000 * 60));
		const elapsedHours = Math.floor(elapsed / 60);
		const elapsedMins = elapsed % 60;
		const remainingHours = Math.floor(remaining / 60);
		const remainingMins = remaining % 60;
		return `${start} (${elapsedHours}h ${elapsedMins}m elapsed, ${remainingHours}h ${remainingMins}m remaining)`;
	}

	const hours = Math.floor(duration / 60);
	const mins = duration % 60;
	if (hours > 0) {
		return `${start} (${hours}h ${mins}m)`;
	}
	return `${start} (${mins}m)`;
}

function formatModels(models: string[]): string {
	if (models.length === 0) { return '-'; }
	if (models.length === 1) { return models[0] ?? '-'; }
	return models.join('\n');
}

function parseTokenLimit(value: string | undefined, maxFromAll: number): number | undefined {
	if (!value) { return undefined; }
	if (value === 'max') {
		return maxFromAll > 0 ? maxFromAll : undefined;
	}
	const limit = Number.parseInt(value, 10);
	return Number.isNaN(limit) ? undefined : limit;
}

export const blocksCommand = define({
	name: 'blocks',
	description: 'Show usage report grouped by 5-hour billing blocks',
	args: {
		...sharedCommandConfig.args,
		active: {
			type: 'boolean',
			short: 'a',
			description: 'Show only active block with projections',
			default: false,
		},
		recent: {
			type: 'boolean',
			short: 'r',
			description: 'Show blocks from last 3 days (including active)',
			default: false,
		},
		tokenLimit: {
			type: 'string',
			short: 't',
			description: 'Token limit for quota warnings (e.g., 500000 or "max" for highest previous block)',
		},
	},
	toKebab: true,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		let blocks = await loadFiveHourBlockData({
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: getDefaultClaudePath(),
			mode: ctx.values.mode,
			order: ctx.values.order,
		});

		if (blocks.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify({ blocks: [] }));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate max tokens from ALL blocks before applying filters
		let maxTokensFromAll = 0;
		if (ctx.values.tokenLimit === 'max') {
			for (const block of blocks) {
				if (!block.isGap && !block.isActive) {
					const blockTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
					if (blockTokens > maxTokensFromAll) {
						maxTokensFromAll = blockTokens;
					}
				}
			}
			if (!ctx.values.json && maxTokensFromAll > 0) {
				logger.info(`Using max tokens from previous sessions: ${formatNumber(maxTokensFromAll)}`);
			}
		}

		// Apply filters
		if (ctx.values.recent) {
			blocks = filterRecentBlocks(blocks, 3);
		}

		if (ctx.values.active) {
			blocks = blocks.filter(block => block.isActive);
			if (blocks.length === 0) {
				if (ctx.values.json) {
					log(JSON.stringify({ blocks: [], message: 'No active block' }));
				}
				else {
					logger.info('No active 5-hour block found.');
				}
				process.exit(0);
			}
		}

		if (ctx.values.json) {
			// JSON output
			const jsonOutput = {
				blocks: blocks.map((block) => {
					const burnRate = block.isActive ? calculateBurnRate(block) : null;
					const projection = block.isActive ? projectBlockUsage(block) : null;

					return {
						id: block.id,
						startTime: block.startTime.toISOString(),
						endTime: block.endTime.toISOString(),
						actualEndTime: block.actualEndTime?.toISOString() || null,
						isActive: block.isActive,
						isGap: block.isGap || false,
						entries: block.entries.length,
						tokenCounts: block.tokenCounts,
						totalTokens:
							block.tokenCounts.inputTokens
							+ block.tokenCounts.outputTokens,
						costUSD: block.costUSD,
						models: block.models,
						burnRate,
						projection,
						tokenLimitStatus: projection && ctx.values.tokenLimit
							? (() => {
									const limit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);
									return limit
										? {
												limit,
												projectedUsage: projection.totalTokens,
												percentUsed: (projection.totalTokens / limit) * 100,
												status: projection.totalTokens > limit
													? 'exceeds'
													: projection.totalTokens > limit * 0.8 ? 'warning' : 'ok',
											}
										: undefined;
								})()
							: undefined,
					};
				}),
			};

			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Table output
			if (ctx.values.active && blocks.length === 1) {
				// Detailed active block view
				const block = blocks[0];
				if (!block) {
					logger.warn('No active block found.');
					process.exit(0);
				}
				const burnRate = calculateBurnRate(block);
				const projection = projectBlockUsage(block);

				logger.box('Current 5-Hour Block Status');

				const now = new Date();
				const elapsed = Math.round(
					(now.getTime() - block.startTime.getTime()) / (1000 * 60),
				);
				const remaining = Math.round(
					(block.endTime.getTime() - now.getTime()) / (1000 * 60),
				);

				log(`Block Started: ${pc.cyan(block.startTime.toLocaleString())} (${pc.yellow(`${Math.floor(elapsed / 60)}h ${elapsed % 60}m`)} ago)`);
				log(`Time Remaining: ${pc.green(`${Math.floor(remaining / 60)}h ${remaining % 60}m`)}\n`);

				log(pc.bold('Current Usage:'));
				log(`  Input Tokens:     ${formatNumber(block.tokenCounts.inputTokens)}`);
				log(`  Output Tokens:    ${formatNumber(block.tokenCounts.outputTokens)}`);
				log(`  Total Cost:       ${formatCurrency(block.costUSD)}\n`);

				if (burnRate) {
					log(pc.bold('Burn Rate:'));
					log(`  Tokens/minute:    ${formatNumber(burnRate.tokensPerMinute)}`);
					log(`  Cost/hour:        ${formatCurrency(burnRate.costPerHour)}\n`);
				}

				if (projection) {
					log(pc.bold('Projected Usage (if current rate continues):'));
					log(`  Total Tokens:     ${formatNumber(projection.totalTokens)}`);
					log(`  Total Cost:       ${formatCurrency(projection.totalCost)}\n`);

					if (ctx.values.tokenLimit) {
						// Parse token limit
						const limit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);
						if (limit) {
							const currentTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
							const remainingTokens = Math.max(0, limit - currentTokens);
							const percentUsed = (projection.totalTokens / limit) * 100;
							const status = percentUsed > 100
								? pc.red('EXCEEDS LIMIT')
								: percentUsed > 80
									? pc.yellow('WARNING')
									: pc.green('OK');

							log(pc.bold('Token Limit Status:'));
							log(`  Limit:            ${formatNumber(limit)} tokens`);
							log(`  Current Usage:    ${formatNumber(currentTokens)} (${((currentTokens / limit) * 100).toFixed(1)}%)`);
							log(`  Remaining:        ${formatNumber(remainingTokens)} tokens`);
							log(`  Projected Usage:  ${percentUsed.toFixed(1)}% ${status}`);
						}
					}
				}
			}
			else {
				// Table view for multiple blocks
				logger.box('Claude Code Token Usage Report - 5-Hour Blocks');

				// Calculate token limit if "max" is specified
				const actualTokenLimit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);

				const tableHeaders = ['Block Start', 'Duration/Status', 'Models', 'Tokens'];
				const tableAligns: ('left' | 'right')[] = ['left', 'left', 'left', 'right'];

				// Add % column if token limit is set
				if (actualTokenLimit) {
					tableHeaders.push('%');
					tableAligns.push('right');
				}

				tableHeaders.push('Cost');
				tableAligns.push('right');

				const table = new Table({
					head: tableHeaders,
					style: { head: ['cyan'] },
					colAligns: tableAligns,
				});

				for (const block of blocks) {
					if (block.isGap) {
						// Gap row
						const gapRow = [
							pc.gray(formatBlockTime(block)),
							pc.gray('(inactive)'),
							pc.gray('-'),
							pc.gray('-'),
						];
						if (actualTokenLimit) {
							gapRow.push(pc.gray('-'));
						}
						gapRow.push(pc.gray('-'));
						table.push(gapRow);
					}
					else {
						const totalTokens
							= block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
						const status = block.isActive ? pc.green('ACTIVE') : '';

						const row = [
							formatBlockTime(block),
							status,
							formatModels(block.models),
							formatNumber(totalTokens),
						];

						// Add percentage if token limit is set
						if (actualTokenLimit) {
							const percentage = (totalTokens / actualTokenLimit) * 100;
							const percentText = `${percentage.toFixed(1)}%`;
							row.push(percentage > 100 ? pc.red(percentText) : percentText);
						}

						row.push(formatCurrency(block.costUSD));
						table.push(row);

						// Add REMAINING and PROJECTED rows for active blocks
						if (block.isActive) {
							// REMAINING row - only show if token limit is set
							if (actualTokenLimit) {
								const currentTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
								const remainingTokens = Math.max(0, actualTokenLimit - currentTokens);
								const remainingText = remainingTokens > 0
									? formatNumber(remainingTokens)
									: pc.red('0');

								// Calculate remaining percentage (how much of limit is left)
								const remainingPercent = ((actualTokenLimit - currentTokens) / actualTokenLimit) * 100;
								const remainingPercentText = remainingPercent > 0
									? `${remainingPercent.toFixed(1)}%`
									: pc.red('0.0%');

								const remainingRow = [
									{ content: pc.gray(`(assuming ${formatNumber(actualTokenLimit)} token limit)`), hAlign: 'right' as const },
									pc.blue('REMAINING'),
									'',
									remainingText,
									remainingPercentText,
									'', // No cost for remaining - it's about token limit, not cost
								];
								table.push(remainingRow);
							}

							// PROJECTED row
							const projection = projectBlockUsage(block);
							if (projection) {
								const projectedTokens = formatNumber(projection.totalTokens);
								const projectedText = actualTokenLimit && projection.totalTokens > actualTokenLimit
									? pc.red(projectedTokens)
									: projectedTokens;

								const projectedRow = [
									{ content: pc.gray('(assuming current burn rate)'), hAlign: 'right' as const },
									pc.yellow('PROJECTED'),
									'',
									projectedText,
								];

								// Add percentage if token limit is set
								if (actualTokenLimit) {
									const percentage = (projection.totalTokens / actualTokenLimit) * 100;
									const percentText = `${percentage.toFixed(1)}%`;
									projectedRow.push(percentage > 100 ? pc.red(percentText) : percentText);
								}
								else {
									projectedRow.push(''); // Empty cell for percentage column
								}

								projectedRow.push(formatCurrency(projection.totalCost));
								table.push(projectedRow);
							}
						}
					}
				}

				log(table.toString());
			}
		}
	},
});
