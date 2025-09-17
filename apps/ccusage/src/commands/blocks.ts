import type { SessionBlock } from '../_session-blocks.ts';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { BLOCKS_COMPACT_WIDTH_THRESHOLD, BLOCKS_DEFAULT_TERMINAL_WIDTH, BLOCKS_WARNING_THRESHOLD, DEFAULT_RECENT_DAYS, DEFAULT_REFRESH_INTERVAL_SECONDS, MAX_REFRESH_INTERVAL_SECONDS, MIN_REFRESH_INTERVAL_SECONDS } from '../_consts.ts';
import { processWithJq } from '../_jq-processor.ts';
import {
	calculateBurnRate,
	DEFAULT_SESSION_DURATION_HOURS,
	filterRecentBlocks,
	projectBlockUsage,

} from '../_session-blocks.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, ResponsiveTable } from '../_table.ts';
import { getTotalTokens } from '../_token-utils.ts';
import { getClaudePaths, loadSessionBlockData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';
import { startLiveMonitoring } from './_blocks.live.ts';

/**
 * Formats the time display for a session block
 * @param block - Session block to format
 * @param compact - Whether to use compact formatting for narrow terminals
 * @param locale - Locale for date/time formatting
 * @returns Formatted time string with duration and status information
 */
function formatBlockTime(block: SessionBlock, compact = false, locale?: string): string {
	const start = compact
		? block.startTime.toLocaleString(locale, {
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			})
		: block.startTime.toLocaleString(locale);

	if (block.isGap ?? false) {
		const end = compact
			? block.endTime.toLocaleString(locale, {
					hour: '2-digit',
					minute: '2-digit',
				})
			: block.endTime.toLocaleString(locale);
		const duration = Math.round((block.endTime.getTime() - block.startTime.getTime()) / (1000 * 60 * 60));
		return compact ? `${start}-${end}\n(${duration}h gap)` : `${start} - ${end} (${duration}h gap)`;
	}

	const duration = block.actualEndTime != null
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

		if (compact) {
			return `${start}\n(${elapsedHours}h${elapsedMins}m/${remainingHours}h${remainingMins}m)`;
		}
		return `${start} (${elapsedHours}h ${elapsedMins}m elapsed, ${remainingHours}h ${remainingMins}m remaining)`;
	}

	const hours = Math.floor(duration / 60);
	const mins = duration % 60;
	if (compact) {
		return hours > 0 ? `${start}\n(${hours}h${mins}m)` : `${start}\n(${mins}m)`;
	}
	if (hours > 0) {
		return `${start} (${hours}h ${mins}m)`;
	}
	return `${start} (${mins}m)`;
}

/**
 * Formats the list of models used in a block for display
 * @param models - Array of model names
 * @returns Formatted model names string
 */
function formatModels(models: string[]): string {
	if (models.length === 0) {
		return '-';
	}
	// Use consistent multiline format across all commands
	return formatModelsDisplayMultiline(models);
}

/**
 * Parses token limit argument, supporting 'max' keyword
 * @param value - Token limit string value
 * @param maxFromAll - Maximum token count found in all blocks
 * @returns Parsed token limit or undefined if invalid
 */
function parseTokenLimit(value: string | undefined, maxFromAll: number): number | undefined {
	if (value == null || value === '' || value === 'max') {
		return maxFromAll > 0 ? maxFromAll : undefined;
	}

	const limit = Number.parseInt(value, 10);
	return Number.isNaN(limit) ? undefined : limit;
}

export const blocksCommand = define({
	name: 'blocks',
	description: 'Show usage report grouped by session billing blocks',
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
			description: `Show blocks from last ${DEFAULT_RECENT_DAYS} days (including active)`,
			default: false,
		},
		tokenLimit: {
			type: 'string',
			short: 't',
			description: 'Token limit for quota warnings (e.g., 500000 or "max")',
		},
		sessionLength: {
			type: 'number',
			short: 'n',
			description: `Session block duration in hours (default: ${DEFAULT_SESSION_DURATION_HOURS})`,
			default: DEFAULT_SESSION_DURATION_HOURS,
		},
		live: {
			type: 'boolean',
			description: 'Live monitoring mode with real-time updates',
			default: false,
		},
		refreshInterval: {
			type: 'number',
			description: `Refresh interval in seconds for live mode (default: ${DEFAULT_REFRESH_INTERVAL_SECONDS})`,
			default: DEFAULT_REFRESH_INTERVAL_SECONDS,
		},
	},
	toKebab: true,
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = mergedOptions.json || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Validate session length
		if (ctx.values.sessionLength <= 0) {
			logger.error('Session length must be a positive number');
			process.exit(1);
		}

		let blocks = await loadSessionBlockData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			sessionDurationHours: ctx.values.sessionLength,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
		});

		if (blocks.length === 0) {
			if (useJson) {
				log(JSON.stringify({ blocks: [] }));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate max tokens from ALL blocks before applying filters
		let maxTokensFromAll = 0;
		if (ctx.values.tokenLimit === 'max' || ctx.values.tokenLimit == null || ctx.values.tokenLimit === '') {
			for (const block of blocks) {
				if (!(block.isGap ?? false) && !block.isActive) {
					const blockTokens = getTotalTokens(block.tokenCounts);
					if (blockTokens > maxTokensFromAll) {
						maxTokensFromAll = blockTokens;
					}
				}
			}
			if (!useJson && maxTokensFromAll > 0) {
				logger.info(`Using max tokens from previous sessions: ${formatNumber(maxTokensFromAll)}`);
			}
		}

		// Apply filters
		if (ctx.values.recent) {
			blocks = filterRecentBlocks(blocks, DEFAULT_RECENT_DAYS);
		}

		if (ctx.values.active) {
			blocks = blocks.filter((block: SessionBlock) => block.isActive);
			if (blocks.length === 0) {
				if (useJson) {
					log(JSON.stringify({ blocks: [], message: 'No active block' }));
				}
				else {
					logger.info('No active session block found.');
				}
				process.exit(0);
			}
		}

		// Live monitoring mode
		if (ctx.values.live && !useJson) {
			// Live mode only shows active blocks
			if (!ctx.values.active) {
				logger.info('Live mode automatically shows only active blocks.');
			}

			// Default to 'max' if no token limit specified in live mode
			let tokenLimitValue = ctx.values.tokenLimit;
			if (tokenLimitValue == null || tokenLimitValue === '') {
				tokenLimitValue = 'max';
				if (maxTokensFromAll > 0) {
					logger.info(`No token limit specified, using max from previous sessions: ${formatNumber(maxTokensFromAll)}`);
				}
			}

			// Validate refresh interval
			const refreshInterval = Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.min(MAX_REFRESH_INTERVAL_SECONDS, ctx.values.refreshInterval));
			if (refreshInterval !== ctx.values.refreshInterval) {
				logger.warn(`Refresh interval adjusted to ${refreshInterval} seconds (valid range: ${MIN_REFRESH_INTERVAL_SECONDS}-${MAX_REFRESH_INTERVAL_SECONDS})`);
			}

			// Start live monitoring
			const paths = getClaudePaths();
			if (paths.length === 0) {
				logger.error('No valid Claude data directory found');
				throw new Error('No valid Claude data directory found');
			}

			await startLiveMonitoring({
				claudePaths: paths,
				tokenLimit: parseTokenLimit(tokenLimitValue, maxTokensFromAll),
				refreshInterval: refreshInterval * 1000, // Convert to milliseconds
				sessionDurationHours: ctx.values.sessionLength,
				mode: ctx.values.mode,
				order: ctx.values.order,
			});
			return; // Exit early, don't show table
		}

		if (useJson) {
			// JSON output
			const jsonOutput = {
				blocks: blocks.map((block: SessionBlock) => {
					const burnRate = block.isActive ? calculateBurnRate(block) : null;
					const projection = block.isActive ? projectBlockUsage(block) : null;

					return {
						id: block.id,
						startTime: block.startTime.toISOString(),
						endTime: block.endTime.toISOString(),
						actualEndTime: block.actualEndTime?.toISOString() ?? null,
						isActive: block.isActive,
						isGap: block.isGap ?? false,
						entries: block.entries.length,
						tokenCounts: block.tokenCounts,
						totalTokens: getTotalTokens(block.tokenCounts),
						costUSD: block.costUSD,
						models: block.models,
						burnRate,
						projection,
						tokenLimitStatus: projection != null && ctx.values.tokenLimit != null
							? (() => {
									const limit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);
									return limit != null
										? {
												limit,
												projectedUsage: projection.totalTokens,
												percentUsed: (projection.totalTokens / limit) * 100,
												status: projection.totalTokens > limit
													? 'exceeds'
													: projection.totalTokens > limit * BLOCKS_WARNING_THRESHOLD ? 'warning' : 'ok',
											}
										: undefined;
								})()
							: undefined,
						usageLimitResetTime: block.usageLimitResetTime,
					};
				}),
			};

			// Process with jq if specified
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error((jqResult.error).message);
					process.exit(1);
				}
				log(jqResult.value);
			}
			else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		}
		else {
			// Table output
			if (ctx.values.active && blocks.length === 1) {
				// Detailed active block view
				const block = blocks[0] as SessionBlock;
				if (block == null) {
					logger.warn('No active block found.');
					process.exit(0);
				}
				const burnRate = calculateBurnRate(block);
				const projection = projectBlockUsage(block);

				logger.box('Current Session Block Status');

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

				if (burnRate != null) {
					log(pc.bold('Burn Rate:'));
					log(`  Tokens/minute:    ${formatNumber(burnRate.tokensPerMinute)}`);
					log(`  Cost/hour:        ${formatCurrency(burnRate.costPerHour)}\n`);
				}

				if (projection != null) {
					log(pc.bold('Projected Usage (if current rate continues):'));
					log(`  Total Tokens:     ${formatNumber(projection.totalTokens)}`);
					log(`  Total Cost:       ${formatCurrency(projection.totalCost)}\n`);

					if (ctx.values.tokenLimit != null) {
						// Parse token limit
						const limit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);
						if (limit != null && limit > 0) {
							const currentTokens = getTotalTokens(block.tokenCounts);
							const remainingTokens = Math.max(0, limit - currentTokens);
							const percentUsed = (projection.totalTokens / limit) * 100;
							const status = percentUsed > 100
								? pc.red('EXCEEDS LIMIT')
								: percentUsed > BLOCKS_WARNING_THRESHOLD * 100
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
				logger.box('Claude Code Token Usage Report - Session Blocks');

				// Calculate token limit if "max" is specified
				const actualTokenLimit = parseTokenLimit(ctx.values.tokenLimit, maxTokensFromAll);

				const tableHeaders = ['Block Start', 'Duration/Status', 'Models', 'Tokens'];
				const tableAligns: ('left' | 'right' | 'center')[] = ['left', 'left', 'left', 'right'];

				// Add % column if token limit is set
				if (actualTokenLimit != null && actualTokenLimit > 0) {
					tableHeaders.push('%');
					tableAligns.push('right');
				}

				tableHeaders.push('Cost');
				tableAligns.push('right');

				const table = new ResponsiveTable({
					head: tableHeaders,
					style: { head: ['cyan'] },
					colAligns: tableAligns,
				});

				// Detect if we need compact formatting
				// Use compact format if:
				// 1. User explicitly requested it with --compact flag
				// 2. Terminal width is below threshold
				const terminalWidth = process.stdout.columns || BLOCKS_DEFAULT_TERMINAL_WIDTH;
				const isNarrowTerminal = terminalWidth < BLOCKS_COMPACT_WIDTH_THRESHOLD;
				const useCompactFormat = ctx.values.compact || isNarrowTerminal;

				for (const block of blocks) {
					if (block.isGap ?? false) {
						// Gap row
						const gapRow = [
							pc.gray(formatBlockTime(block, useCompactFormat, ctx.values.locale)),
							pc.gray('(inactive)'),
							pc.gray('-'),
							pc.gray('-'),
						];
						if (actualTokenLimit != null && actualTokenLimit > 0) {
							gapRow.push(pc.gray('-'));
						}
						gapRow.push(pc.gray('-'));
						table.push(gapRow);
					}
					else {
						const totalTokens
							= getTotalTokens(block.tokenCounts);
						const status = block.isActive ? pc.green('ACTIVE') : '';

						const row = [
							formatBlockTime(block, useCompactFormat, ctx.values.locale),
							status,
							formatModels(block.models),
							formatNumber(totalTokens),
						];

						// Add percentage if token limit is set
						if (actualTokenLimit != null && actualTokenLimit > 0) {
							const percentage = (totalTokens / actualTokenLimit) * 100;
							const percentText = `${percentage.toFixed(1)}%`;
							row.push(percentage > 100 ? pc.red(percentText) : percentText);
						}

						row.push(formatCurrency(block.costUSD));
						table.push(row);

						// Add REMAINING and PROJECTED rows for active blocks
						if (block.isActive) {
							// REMAINING row - only show if token limit is set
							if (actualTokenLimit != null && actualTokenLimit > 0) {
								const currentTokens = getTotalTokens(block.tokenCounts);
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
							if (projection != null) {
								const projectedTokens = formatNumber(projection.totalTokens);
								const projectedText = actualTokenLimit != null && actualTokenLimit > 0 && projection.totalTokens > actualTokenLimit
									? pc.red(projectedTokens)
									: projectedTokens;

								const projectedRow = [
									{ content: pc.gray('(assuming current burn rate)'), hAlign: 'right' as const },
									pc.yellow('PROJECTED'),
									'',
									projectedText,
								];

								// Add percentage if token limit is set
								if (actualTokenLimit != null && actualTokenLimit > 0) {
									const percentage = (projection.totalTokens / actualTokenLimit) * 100;
									const percentText = `${percentage.toFixed(1)}%`;
									projectedRow.push(percentText);
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
