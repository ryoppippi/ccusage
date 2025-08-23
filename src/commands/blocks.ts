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
import { getTotalTokens } from '../_token-utils.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, ResponsiveTable } from '../_utils.ts';
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
 * Extracts the calculation method from token limit value
 * @param value - Token limit string value
 * @returns The method ('max', 'avg', 'median') or 'max' as default
 */
function getTokenLimitMethod(value: string | undefined | null): 'max' | 'avg' | 'median' {
	if (value === 'avg') {
		return 'avg';
	}
	if (value === 'median') {
		return 'median';
	}
	return 'max'; // default for 'max', null, undefined, empty string, or numeric values
}

/**
 * Parses token limit argument, supporting 'max', 'avg', and 'median' keywords
 * @param value - Token limit string value
 * @param calculatedLimit - Calculated token limit based on selected method and sessions
 * @returns Parsed token limit or undefined if invalid
 */
function parseTokenLimit(value: string | undefined | null, calculatedLimit: number): number | undefined {
	if (value === null || value === undefined || value === '' || value === 'max' || value === 'avg' || value === 'median') {
		return calculatedLimit > 0 ? calculatedLimit : undefined;
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
			description: 'Token limit for quota warnings (number, "max", "avg", or "median")',
		},
		sessionLength: {
			type: 'number',
			short: 'n',
			description: `Session block duration in hours (default: ${DEFAULT_SESSION_DURATION_HOURS})`,
			default: DEFAULT_SESSION_DURATION_HOURS,
		},
		tokenLimitSessions: {
			type: 'number',
			description: 'Number of recent completed sessions to use for token limit calculation (default: all sessions)',
			default: 10,
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
		const useJson = mergedOptions.json === true || mergedOptions.jq != null;
		if (useJson === true) {
			logger.level = 0;
		}

		// Validate session length
		if (ctx.values.sessionLength <= 0) {
			logger.error('Session length must be a positive number');
			process.exit(1);
		}

		// Validate token limit sessions
		if (ctx.values.tokenLimitSessions != null && ctx.values.tokenLimitSessions <= 0) {
			logger.error('Token limit sessions must be a positive number');
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
			if (useJson === true) {
				log(JSON.stringify({ blocks: [] }));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate token limit from recent completed sessions
		let calculatedTokenLimit = 0;
		const tokenLimitMethod = getTokenLimitMethod(ctx.values.tokenLimit);
		const tokenLimitSessions = ctx.values.tokenLimitSessions; // null means all sessions

		if (ctx.values.tokenLimit === 'max' || ctx.values.tokenLimit === 'avg' || ctx.values.tokenLimit === 'median' || ctx.values.tokenLimit == null || ctx.values.tokenLimit === '') {
			const completedBlocks: SessionBlock[] = [];

			// Collect all completed blocks (non-gap, non-active)
			for (const block of blocks) {
				if (!(block.isGap ?? false) && !block.isActive) {
					completedBlocks.push(block);
				}
			}

			// Sort by start time (most recent first) and take the specified number
			completedBlocks.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
			const blocksToUse = tokenLimitSessions != null
				? completedBlocks.slice(0, tokenLimitSessions)
				: completedBlocks;

			if (blocksToUse.length > 0) {
				const blockTokens = blocksToUse.map(block => getTotalTokens(block.tokenCounts));

				switch (tokenLimitMethod) {
					case 'avg': {
						calculatedTokenLimit = Math.round(
							blockTokens.reduce((sum, tokens) => sum + tokens, 0) / blockTokens.length,
						);
						break;
					}
					case 'median': {
						const sortedTokens = [...blockTokens].sort((a, b) => a - b);
						if (sortedTokens.length === 0) {
							calculatedTokenLimit = 0;
						}
						else {
							const mid = Math.floor(sortedTokens.length / 2);
							calculatedTokenLimit = sortedTokens.length % 2 === 0
								? Math.round(((sortedTokens[mid - 1] ?? 0) + (sortedTokens[mid] ?? 0)) / 2)
								: sortedTokens[mid] ?? 0;
						}
						break;
					}
					case 'max':
					default:
						calculatedTokenLimit = Math.max(...blockTokens);
						break;
				}

				if (useJson !== true) {
					const sessionsText = blocksToUse.length === 1 ? 'session' : 'sessions';
					const recentText = tokenLimitSessions != null ? ` recent` : '';
					logger.info(`Using ${tokenLimitMethod} tokens from ${blocksToUse.length}${recentText} ${sessionsText}: ${formatNumber(calculatedTokenLimit)}`);
				}
			}
			else if (useJson !== true) {
				logger.warn('No completed sessions found for token limit calculation');
			}
		}

		// Apply filters
		if (ctx.values.recent === true) {
			blocks = filterRecentBlocks(blocks, DEFAULT_RECENT_DAYS);
		}

		if (ctx.values.active === true) {
			blocks = blocks.filter((block: SessionBlock) => block.isActive);
			if (blocks.length === 0) {
				if (useJson === true) {
					log(JSON.stringify({ blocks: [], message: 'No active block' }));
				}
				else {
					logger.info('No active session block found.');
				}
				process.exit(0);
			}
		}

		// Live monitoring mode
		if (ctx.values.live === true && useJson !== true) {
			// Live mode only shows active blocks
			if (ctx.values.active !== true) {
				logger.info('Live mode automatically shows only active blocks.');
			}

			// Default to 'max' if no token limit specified in live mode
			let tokenLimitValue = ctx.values.tokenLimit;
			if (tokenLimitValue == null || tokenLimitValue === '') {
				tokenLimitValue = 'max';
				if (calculatedTokenLimit > 0) {
					logger.info(`No token limit specified, using max from previous sessions: ${formatNumber(calculatedTokenLimit)}`);
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
				tokenLimit: parseTokenLimit(tokenLimitValue, calculatedTokenLimit),
				refreshInterval: refreshInterval * 1000, // Convert to milliseconds
				sessionDurationHours: ctx.values.sessionLength,
				mode: ctx.values.mode,
				order: ctx.values.order,
			});
			return; // Exit early, don't show table
		}

		if (useJson === true) {
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
									const limit = parseTokenLimit(ctx.values.tokenLimit, calculatedTokenLimit);
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
			if (ctx.values.active === true && blocks.length === 1) {
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
						const limit = parseTokenLimit(ctx.values.tokenLimit, calculatedTokenLimit);
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
				const actualTokenLimit = parseTokenLimit(ctx.values.tokenLimit, calculatedTokenLimit);

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
				const terminalWidth = process.stdout.columns ?? BLOCKS_DEFAULT_TERMINAL_WIDTH;
				const isNarrowTerminal = terminalWidth < BLOCKS_COMPACT_WIDTH_THRESHOLD;
				const useCompactFormat = ctx.values.compact === true || isNarrowTerminal;

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

if (import.meta.vitest != null) {
	/* eslint-disable ts/no-unused-vars, ts/no-unsafe-member-access, ts/no-unsafe-argument */
	describe('getTokenLimitMethod', () => {
		it('returns correct method for valid keywords', () => {
			expect(getTokenLimitMethod('max')).toBe('max');
			expect(getTokenLimitMethod('avg')).toBe('avg');
			expect(getTokenLimitMethod('median')).toBe('median');
		});

		it('returns max as default for other values', () => {
			expect(getTokenLimitMethod(undefined)).toBe('max');
			expect(getTokenLimitMethod(null)).toBe('max');
			expect(getTokenLimitMethod('')).toBe('max');
			expect(getTokenLimitMethod('1000')).toBe('max');
			expect(getTokenLimitMethod('invalid')).toBe('max');
		});
	});

	describe('parseTokenLimit', () => {
		it('returns calculated limit when value is null or empty', () => {
			expect(parseTokenLimit(undefined, 500)).toBe(500);
			expect(parseTokenLimit('', 500)).toBe(500);
			expect(parseTokenLimit(null, 500)).toBe(500);
		});

		it('returns calculated limit when value is method keyword', () => {
			expect(parseTokenLimit('max', 500)).toBe(500);
			expect(parseTokenLimit('avg', 500)).toBe(500);
			expect(parseTokenLimit('median', 500)).toBe(500);
		});

		it('returns undefined when calculated limit is 0', () => {
			expect(parseTokenLimit(undefined, 0)).toBeUndefined();
			expect(parseTokenLimit('', 0)).toBeUndefined();
			expect(parseTokenLimit('max', 0)).toBeUndefined();
			expect(parseTokenLimit('avg', 0)).toBeUndefined();
			expect(parseTokenLimit('median', 0)).toBeUndefined();
		});

		it('parses numeric values correctly', () => {
			expect(parseTokenLimit('1000', 500)).toBe(1000);
			expect(parseTokenLimit('0', 500)).toBe(0);
			expect(parseTokenLimit('999999', 500)).toBe(999999);
		});

		it('returns undefined for invalid numeric values', () => {
			expect(parseTokenLimit('invalid', 500)).toBeUndefined();
			expect(parseTokenLimit('12.5', 500)).toBe(12); // parseInt parses "12.5" as 12
			expect(parseTokenLimit('-100', 500)).toBe(-100); // parseInt parses negative numbers
		});
	});

	// Shared mock data creation function
	async function createMockData(blocks: Array<{
		startTime: string;
		isGap?: boolean;
		isActive?: boolean;
		inputTokens: number;
		outputTokens: number;
		model?: string;
		costUSD?: number;
	}>): Promise<Awaited<ReturnType<typeof import('fs-fixture')['createFixture']>>> {
		// Create directory structure to match Claude data layout
		const fixtureStructure: Record<string, any> = {
			projects: {},
		};

		// Create session files for each block
		blocks.forEach((block, index) => {
			const sessionId = `session-${index + 1}`;
			const projectName = 'test-project';

			if (fixtureStructure.projects[projectName] == null) {
				fixtureStructure.projects[projectName] = {};
			}

			const entry = {
				timestamp: block.startTime,
				sessionId,
				message: {
					id: `msg_${index + 1}`,
					model: block.model ?? 'claude-sonnet-4-20250514',
					usage: {
						input_tokens: block.inputTokens,
						output_tokens: block.outputTokens,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
				requestId: `req_${index + 1}`,
				costUSD: block.costUSD ?? 0.01,
				version: '1.0.0',
			};

			fixtureStructure.projects[projectName][`${sessionId}.jsonl`] = `${JSON.stringify(entry)}\n`;
		});

		const { createFixture } = await import('fs-fixture');
		const fixture = await createFixture(fixtureStructure);

		// Set up environment variable to point to the fixture
		vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.path);

		return fixture;
	}

	describe('Token Limit Calculation Logic', () => {
		beforeEach(() => {
			vi.stubEnv('HOME', '/test-home');
			vi.stubEnv('USERPROFILE', '/test-home');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('calculates max token limit correctly', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 }, // total: 300
				{ startTime: '2024-01-01T12:00:00Z', inputTokens: 150, outputTokens: 75 }, // total: 225
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			// Filter out gaps and active blocks
			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			expect(completedBlocks).toHaveLength(3);

			// Sort by start time (most recent first) - should be: 300, 225, 150
			completedBlocks.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			expect(blockTokens).toEqual([225, 300, 150]);
			expect(Math.max(...blockTokens)).toBe(300);
		});

		it('calculates average token limit correctly', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 }, // total: 300
				{ startTime: '2024-01-01T12:00:00Z', inputTokens: 250, outputTokens: 100 }, // total: 350
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			// Average of [350, 300, 150] = 800 / 3 = 266.67 -> Math.round = 267
			const average = Math.round(blockTokens.reduce((sum, tokens) => sum + tokens, 0) / blockTokens.length);
			expect(average).toBe(267);
		});

		it('calculates median token limit correctly for odd count', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 }, // total: 300
				{ startTime: '2024-01-01T12:00:00Z', inputTokens: 400, outputTokens: 100 }, // total: 500
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			// Sort tokens: [150, 300, 500], median = 300 (middle value)
			const sortedTokens = [...blockTokens].sort((a, b) => a - b);
			const mid = Math.floor(sortedTokens.length / 2);
			expect(sortedTokens[mid]).toBe(300);
		});

		it('calculates median token limit correctly for even count', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 }, // total: 300
				{ startTime: '2024-01-01T12:00:00Z', inputTokens: 400, outputTokens: 100 }, // total: 500
				{ startTime: '2024-01-01T18:00:00Z', inputTokens: 500, outputTokens: 100 }, // total: 600
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			// Sort tokens: [150, 300, 500, 600], median = (300 + 500) / 2 = 400
			const sortedTokens = [...blockTokens].sort((a, b) => a - b);
			const mid = Math.floor(sortedTokens.length / 2);
			const median = Math.round(((sortedTokens[mid - 1] ?? 0) + (sortedTokens[mid] ?? 0)) / 2);
			expect(median).toBe(400);
		});

		it('limits sessions correctly when tokenLimitSessions is specified', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 0 }, // total: 100 (oldest)
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 0 }, // total: 200
				{ startTime: '2024-01-01T12:00:00Z', inputTokens: 300, outputTokens: 0 }, // total: 300
				{ startTime: '2024-01-01T18:00:00Z', inputTokens: 400, outputTokens: 0 }, // total: 400
				{ startTime: '2024-01-02T00:00:00Z', inputTokens: 500, outputTokens: 0 }, // total: 500 (newest)
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			// Sort by start time (most recent first)
			completedBlocks.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

			// Take only 3 most recent sessions: [500, 400, 300]
			const blocksToUse = completedBlocks.slice(0, 3);
			const blockTokens = blocksToUse.map(block => getTotalTokens(block.tokenCounts));

			expect(blockTokens).toEqual([500, 400, 300]);
			expect(Math.max(...blockTokens)).toBe(500);
		});

		it('excludes gap blocks from calculation', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 }, // total: 300
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			// Manually mark one as gap for testing (simulates gap detection logic)
			if (blocks.length >= 2) {
				blocks[1]!.isGap = true;
			}

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			// Expect at least 1 block (since we only marked one as gap, and others should not be active)
			expect(completedBlocks.length).toBeGreaterThan(0);

			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));
			// Should include the block that wasn't marked as gap
			expect(blockTokens).toContain(300);
		});

		it('excludes active blocks from calculation', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 }, // total: 300
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			// Manually mark the first block (which should be the most recent = 300 tokens) as active for testing
			if (blocks.length >= 1) {
				blocks[0]!.isActive = true;
			}

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			expect(completedBlocks).toHaveLength(1);

			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));
			// Should be 150 (the older block) since the 300 token block is marked as active
			expect(Math.max(...blockTokens)).toBe(150);
		});

		it('returns 0 when no completed sessions are found', async () => {
			await using _fixture = await createMockData([]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			expect(completedBlocks).toHaveLength(0);

			// Calculated limit should be 0
			const calculatedTokenLimit = completedBlocks.length > 0 ? Math.max(...completedBlocks.map(block => getTotalTokens(block.tokenCounts))) : 0;
			expect(calculatedTokenLimit).toBe(0);
		});

		it('handles single session correctly for all methods', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 150, outputTokens: 75 }, // total: 225
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			expect(completedBlocks).toHaveLength(1);

			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));
			expect(blockTokens).toEqual([225]);

			// All methods should return the same value for single session
			expect(Math.max(...blockTokens)).toBe(225); // max
			expect(Math.round(blockTokens.reduce((sum, tokens) => sum + tokens, 0) / blockTokens.length)).toBe(225); // avg

			const sortedTokens = [...blockTokens].sort((a, b) => a - b);
			const mid = Math.floor(sortedTokens.length / 2);
			expect(sortedTokens[mid]).toBe(225); // median (odd count)
		});

		it('sorts sessions by most recent first', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 0 }, // oldest: 100
				{ startTime: '2024-01-01T12:00:00Z', inputTokens: 300, outputTokens: 0 }, // middle: 300
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 0 }, // newest: 200
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);

			// Sort by start time (most recent first)
			completedBlocks.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			// Should be sorted as: 300 (12:00), 200 (06:00), 100 (00:00)
			expect(blockTokens).toEqual([300, 200, 100]);
		});
	});

	describe('CLI Integration Tests', () => {
		beforeEach(() => {
			vi.stubEnv('HOME', '/test-home');
			vi.stubEnv('USERPROFILE', '/test-home');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		// Mock the command execution context
		function createMockContext(overrides: Partial<any> = {}): { values: any; tokens: unknown[] } {
			return {
				values: {
					tokenLimitSessions: null,
					tokenLimit: undefined,
					sessionLength: 5,
					json: false,
					mode: 'display',
					order: 'desc',
					offline: true,
					timezone: 'UTC',
					locale: 'en-US',
					...overrides,
				},
				tokens: [],
			};
		}

		it('uses default values correctly', () => {
			const ctx = createMockContext();
			expect(ctx.values.tokenLimitSessions).toBeNull();
			expect(getTokenLimitMethod(ctx.values.tokenLimit)).toBe('max'); // default method
		});

		it('accepts valid tokenLimit method values', () => {
			const maxCtx = createMockContext({ tokenLimit: 'max' });
			const avgCtx = createMockContext({ tokenLimit: 'avg' });
			const medianCtx = createMockContext({ tokenLimit: 'median' });

			expect(getTokenLimitMethod(maxCtx.values.tokenLimit)).toBe('max');
			expect(getTokenLimitMethod(avgCtx.values.tokenLimit)).toBe('avg');
			expect(getTokenLimitMethod(medianCtx.values.tokenLimit)).toBe('median');
		});

		it('accepts valid tokenLimitSessions values', () => {
			const nullCtx = createMockContext({ tokenLimitSessions: null });
			const numberCtx = createMockContext({ tokenLimitSessions: 5 });

			expect(nullCtx.values.tokenLimitSessions).toBeNull();
			expect(numberCtx.values.tokenLimitSessions).toBe(5);
		});

		it('maintains backward compatibility with tokenLimit="max"', () => {
			const ctx = createMockContext({ tokenLimit: 'max' });
			expect(ctx.values.tokenLimit).toBe('max');
			expect(getTokenLimitMethod(ctx.values.tokenLimit)).toBe('max');

			// This should trigger the calculation logic (when tokenLimit is "max")
			expect(ctx.values.tokenLimit === 'max').toBe(true);
		});

		it('handles new tokenLimit method values', () => {
			const avgCtx = createMockContext({ tokenLimit: 'avg' });
			const medianCtx = createMockContext({ tokenLimit: 'median' });

			expect(avgCtx.values.tokenLimit).toBe('avg');
			expect(getTokenLimitMethod(avgCtx.values.tokenLimit)).toBe('avg');

			expect(medianCtx.values.tokenLimit).toBe('median');
			expect(getTokenLimitMethod(medianCtx.values.tokenLimit)).toBe('median');
		});

		it('handles explicit numeric tokenLimit values', () => {
			const ctx = createMockContext({ tokenLimit: '50000' });
			expect(ctx.values.tokenLimit).toBe('50000');
			expect(getTokenLimitMethod(ctx.values.tokenLimit)).toBe('max'); // numeric values default to max method

			// parseTokenLimit should handle this correctly
			expect(parseTokenLimit(ctx.values.tokenLimit, 0)).toBe(50000);
		});
	});

	describe('Edge Cases', () => {
		beforeEach(() => {
			vi.stubEnv('HOME', '/test-home');
			vi.stubEnv('USERPROFILE', '/test-home');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('handles empty blocks list', () => {
			const blocks: any[] = [];
			const completedBlocks = blocks.filter((block: any) => (block.isGap ?? false) === false && block.isActive !== true);
			expect(completedBlocks).toHaveLength(0);

			const calculatedTokenLimit = completedBlocks.length > 0 ? Math.max(...completedBlocks.map((block: any) => getTotalTokens(block.tokenCounts))) : 0;
			expect(calculatedTokenLimit).toBe(0);
		});

		it('handles tokenLimitSessions greater than available sessions', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50 },
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 200, outputTokens: 100 },
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			completedBlocks.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

			// Request 10 sessions but only have 2
			const blocksToUse = completedBlocks.slice(0, 10); // Should just return all 2
			expect(blocksToUse).toHaveLength(2);

			const blockTokens = blocksToUse.map(block => getTotalTokens(block.tokenCounts));
			expect(Math.max(...blockTokens)).toBe(300);
		});

		it('handles zero token blocks', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T00:00:00Z', inputTokens: 0, outputTokens: 0 }, // total: 0
				{ startTime: '2024-01-01T06:00:00Z', inputTokens: 100, outputTokens: 50 }, // total: 150
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			expect(blockTokens).toContain(0);
			expect(blockTokens).toContain(150);
			expect(Math.max(...blockTokens)).toBe(150);
		});
	});

	describe('Backwards Compatibility', () => {
		it('maintains old behavior when defaults are used', () => {
			// When tokenLimit defaults to 'max' method and tokenLimitSessions=null,
			// behavior should be identical to the old implementation
			const testTokens = [100, 200, 300, 150, 250];

			// Old behavior: Math.max(...allTokens)
			const oldBehavior = Math.max(...testTokens);

			// New behavior with defaults
			const sortedTokens = [...testTokens]; // no session limiting (null)
			const newBehavior = Math.max(...sortedTokens); // 'max' method (default)

			expect(newBehavior).toBe(oldBehavior);
			expect(newBehavior).toBe(300);
		});

		it('parseTokenLimit preserves backward compatibility', () => {
			// Old behavior: if tokenLimit is "max" or undefined, use calculated limit
			expect(parseTokenLimit('max', 500)).toBe(500);
			expect(parseTokenLimit(undefined, 500)).toBe(500);
			expect(parseTokenLimit('', 500)).toBe(500);

			// New behavior: supports additional method keywords
			expect(parseTokenLimit('avg', 500)).toBe(500);
			expect(parseTokenLimit('median', 500)).toBe(500);

			// Old behavior: if explicit number, use that
			expect(parseTokenLimit('1000', 500)).toBe(1000);

			// Old behavior: if calculated limit is 0 and tokenLimit is "max", return undefined
			expect(parseTokenLimit('max', 0)).toBeUndefined();
			expect(parseTokenLimit('avg', 0)).toBeUndefined();
			expect(parseTokenLimit('median', 0)).toBeUndefined();
		});

		it('getTokenLimitMethod provides consistent method extraction', () => {
			// Default to 'max' for old behavior
			expect(getTokenLimitMethod(undefined)).toBe('max');
			expect(getTokenLimitMethod(null)).toBe('max');
			expect(getTokenLimitMethod('')).toBe('max');
			expect(getTokenLimitMethod('max')).toBe('max');

			// New method support
			expect(getTokenLimitMethod('avg')).toBe('avg');
			expect(getTokenLimitMethod('median')).toBe('median');

			// Numeric values default to 'max' method
			expect(getTokenLimitMethod('50000')).toBe('max');
		});
	});

	describe('Real Scenario Tests', () => {
		beforeEach(() => {
			vi.stubEnv('HOME', '/test-home');
			vi.stubEnv('USERPROFILE', '/test-home');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('handles realistic token usage patterns', async () => {
			// Realistic scenario: morning heavy usage, afternoon light usage, evening moderate
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T08:00:00Z', inputTokens: 5000, outputTokens: 2000 }, // morning: 7000
				{ startTime: '2024-01-01T14:00:00Z', inputTokens: 500, outputTokens: 200 }, // afternoon: 700
				{ startTime: '2024-01-01T20:00:00Z', inputTokens: 2000, outputTokens: 800 }, // evening: 2800
				{ startTime: '2024-01-02T08:00:00Z', inputTokens: 4000, outputTokens: 1500 }, // next day: 5500
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			completedBlocks.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));

			// Expected order (newest first): 5500, 2800, 700, 7000
			expect(blockTokens[0]).toBe(5500); // most recent
			expect(Math.max(...blockTokens)).toBe(7000); // max method

			// Test taking only 2 recent sessions
			const recentTokens = blockTokens.slice(0, 2);
			expect(Math.max(...recentTokens)).toBe(5500);
			expect(Math.round(recentTokens.reduce((sum, tokens) => sum + tokens, 0) / recentTokens.length)).toBe(4150); // avg of 5500, 2800
		});

		it('handles mixed Claude models correctly', async () => {
			await using _fixture = await createMockData([
				{ startTime: '2024-01-01T08:00:00Z', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet-4-20250514' },
				{ startTime: '2024-01-01T14:00:00Z', inputTokens: 2000, outputTokens: 800, model: 'claude-opus-4-20250514' },
				{ startTime: '2024-01-01T20:00:00Z', inputTokens: 1500, outputTokens: 600, model: 'claude-sonnet-4-20250514' },
			]);

			const blocks = await loadSessionBlockData({
				sessionDurationHours: 5,
				mode: 'display',
				order: 'desc',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});

			const completedBlocks = blocks.filter(block => !(block.isGap ?? false) && !block.isActive);
			expect(completedBlocks).toHaveLength(3);

			// Token calculation should work regardless of model
			const blockTokens = completedBlocks.map(block => getTotalTokens(block.tokenCounts));
			expect(blockTokens).toContain(1500); // sonnet
			expect(blockTokens).toContain(2800); // opus
			expect(blockTokens).toContain(2100); // sonnet
		});
	});
}
