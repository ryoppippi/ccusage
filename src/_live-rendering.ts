/**
 * @fileoverview Live rendering module for Claude usage monitoring
 *
 * This module contains all the rendering logic for live monitoring displays,
 * extracted from the command layer to improve separation of concerns.
 * Provides frame rate limiting, display rendering, and layout functions.
 */

import type { SessionBlock } from './_session-blocks.ts';
import type { TerminalManager } from './_terminal-utils.ts';
import type { CostMode, SortOrder } from './_types.ts';
import { delay } from '@std/async';
import * as ansiEscapes from 'ansi-escapes';
import pc from 'picocolors';
import prettyMs from 'pretty-ms';
import stringWidth from 'string-width';
import { BURN_RATE_THRESHOLDS } from './_consts.ts';
import { calculateBurnRate, projectBlockUsage } from './_session-blocks.ts';
import { formatCurrency, formatModelsDisplay, formatNumber } from './_table.ts';
import { centerText, createProgressBar, drawEmoji } from './_terminal-utils.ts';
import { getTotalTokens } from './_token-utils.ts';

/**
 * Get rate indicator (HIGH/MODERATE/NORMAL) based on burn rate
 */
function getRateIndicator(burnRate: ReturnType<typeof calculateBurnRate>): string {
	if (burnRate == null) {
		return '';
	}

	// eslint-disable-next-line ts/switch-exhaustiveness-check
	switch (true) {
		case burnRate.tokensPerMinuteForIndicator > BURN_RATE_THRESHOLDS.HIGH:
			return pc.red(`${drawEmoji('⚡')} HIGH`);
		case burnRate.tokensPerMinuteForIndicator > BURN_RATE_THRESHOLDS.MODERATE:
			return pc.yellow(`${drawEmoji('⚡')} MODERATE`);
		default:
			return pc.green(`${drawEmoji('✓')} NORMAL`);
	}
}

/**
 * Live monitoring configuration
 */
export type LiveMonitoringConfig = {
	claudePaths: string[];
	tokenLimit?: number;
	refreshInterval: number;
	sessionDurationHours: number;
	mode: CostMode;
	order: SortOrder;
};

/**
 * Delay with AbortSignal support and graceful error handling
 */
export async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	await delay(ms, { signal });
}

/**
 * Shows waiting message when no Claude session is active
 * Uses efficient cursor positioning instead of full screen clear
 */
export async function renderWaitingState(terminal: TerminalManager, config: LiveMonitoringConfig, signal: AbortSignal): Promise<void> {
	// Use cursor positioning instead of clearing entire screen for better performance
	terminal.startBuffering();
	terminal.write(ansiEscapes.cursorTo(0, 0)); // Move to top-left
	terminal.write(ansiEscapes.eraseDown); // Clear from cursor down
	terminal.write(pc.yellow('No active session block found. Waiting...\n'));
	terminal.write(ansiEscapes.cursorHide); // Keep cursor hidden
	terminal.flush();

	await delayWithAbort(config.refreshInterval, signal);
}

/**
 * Displays the live monitoring dashboard for active Claude session
 * Uses buffering and sync mode to prevent screen flickering
 */
export function renderActiveBlock(terminal: TerminalManager, activeBlock: SessionBlock, config: LiveMonitoringConfig): void {
	// Use buffering + sync mode for smooth, flicker-free updates
	terminal.startBuffering();
	terminal.write(ansiEscapes.cursorTo(0, 0)); // Move to home position
	terminal.write(ansiEscapes.eraseDown); // Clear screen content
	renderLiveDisplay(terminal, activeBlock, config);
	terminal.write(ansiEscapes.cursorHide); // Ensure cursor stays hidden
	terminal.flush(); // Send all updates atomically
}

/**
 * Format token counts with K suffix for display
 */
function formatTokensShort(num: number): string {
	if (num >= 1000) {
		return `${(num / 1000).toFixed(1)}k`;
	}
	return num.toString();
}

/**
 * Renders the live display for an active session block
 */
export function renderLiveDisplay(terminal: TerminalManager, block: SessionBlock, config: LiveMonitoringConfig): void {
	const width = terminal.width;
	const now = new Date();

	// Calculate key metrics
	const totalTokens = getTotalTokens(block.tokenCounts);
	const elapsed = (now.getTime() - block.startTime.getTime()) / (1000 * 60);
	const remaining = (block.endTime.getTime() - now.getTime()) / (1000 * 60);

	// Helper function to format token display based on available space
	const formatTokenDisplay = (tokens: number, useShort: boolean): string => {
		return useShort ? formatTokensShort(tokens) : formatNumber(tokens);
	};

	// Use compact mode for narrow terminals
	if (width < 60) {
		renderCompactLiveDisplay(terminal, block, config, totalTokens, elapsed, remaining);
		return;
	}

	// Calculate box dimensions - use full width with minimal margins
	const boxWidth = Math.min(120, width - 2); // Use almost full width, leaving 1 char margin on each side
	const boxMargin = Math.floor((width - boxWidth) / 2);
	const marginStr = ' '.repeat(boxMargin);

	// Session progress calculations
	const sessionDuration = elapsed + remaining;
	const sessionPercent = (elapsed / sessionDuration) * 100;

	// Calculate all right-side texts first (before progress bar width calculation)
	const sessionRightText = `${sessionPercent.toFixed(1).padStart(6)}%`;

	const tokenPercent = config.tokenLimit != null && config.tokenLimit > 0
		? (totalTokens / config.tokenLimit) * 100
		: 0;

	const usageRightText = config.tokenLimit != null && config.tokenLimit > 0
		? `${tokenPercent.toFixed(1).padStart(6)}% (${formatTokensShort(totalTokens)}/${formatTokensShort(config.tokenLimit)})`
		: `(${formatTokensShort(totalTokens)} tokens)`;

	// Calculate projection values if needed
	const projection = projectBlockUsage(block);
	const projectedPercent = projection != null && config.tokenLimit != null && config.tokenLimit > 0
		? (projection.totalTokens / config.tokenLimit) * 100
		: 0;

	const projectionRightText = projection != null
		? (config.tokenLimit != null && config.tokenLimit > 0
				? `${projectedPercent.toFixed(1).padStart(6)}% (${formatTokensShort(projection.totalTokens)}/${formatTokensShort(config.tokenLimit)})`
				: `(${formatTokensShort(projection.totalTokens)} tokens)`)
		: '';

	// Calculate maximum width of all right-side texts
	const maxRightTextWidth = Math.max(
		stringWidth(sessionRightText),
		stringWidth(usageRightText),
		projection != null ? stringWidth(projectionRightText) : 0,
	);

	// Calculate dynamic progress bar width based on actual text lengths
	const labelWidth = 14; // Width for labels like "SESSION"
	const spacing = 4; // Spacing between elements
	const boxPadding = 4; // Box border (│ ) + space on left + space + (│) on right
	const barWidth = boxWidth - labelWidth - maxRightTextWidth - spacing - boxPadding;
	const sessionProgressBar = createProgressBar(
		elapsed,
		sessionDuration,
		barWidth,
		{
			showPercentage: false,
			fillChar: pc.cyan('█'),
			emptyChar: pc.gray('░'),
			leftBracket: '[',
			rightBracket: ']',
		},
	);

	// Format times with AM/PM
	const startTime = block.startTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
	const endTime = block.endTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

	// Common layout constants for detail sections
	const detailsIndent = 3; // Leading spaces for all detail rows
	const detailsSpacing = 2; // Fixed spacing between columns
	const detailsAvailableWidth = boxWidth - 3 - detailsIndent; // Available width for content

	// Draw header
	terminal.write(`${marginStr}┌${'─'.repeat(boxWidth - 2)}┐\n`);
	terminal.write(`${marginStr}│${pc.bold(centerText('CLAUDE CODE - LIVE TOKEN USAGE MONITOR', boxWidth - 2))}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Session section
	const sessionLabel = `${drawEmoji('⏱️')}${pc.bold(' SESSION')}`;
	const sessionLabelWidth = stringWidth(sessionLabel);
	const sessionBarStr = `${sessionLabel}${''.padEnd(Math.max(0, labelWidth - sessionLabelWidth))} ${sessionProgressBar} ${sessionRightText}`;
	const sessionBarPadded = sessionBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(sessionBarStr)));
	terminal.write(`${marginStr}│ ${sessionBarPadded}│\n`);

	// Session details (indented)
	const sessionCol1 = `${pc.gray('Started:')} ${startTime}`;
	const sessionCol2 = `${pc.gray('Elapsed:')} ${prettyMs(elapsed * 60 * 1000, { compact: true })}`;
	const sessionCol3 = `${pc.gray('Remaining:')} ${prettyMs(remaining * 60 * 1000, { compact: true })} (${endTime})`;

	// Build session details with fixed 2-space separation
	// First try with all three columns
	let sessionDetails = `${' '.repeat(detailsIndent)}${sessionCol1}${' '.repeat(detailsSpacing)}${sessionCol2}${' '.repeat(detailsSpacing)}${sessionCol3}`;
	const sessionDetailsWidth = stringWidth(sessionCol1) + stringWidth(sessionCol2) + stringWidth(sessionCol3) + (detailsSpacing * 2);

	// If doesn't fit, omit Elapsed column
	if (sessionDetailsWidth > detailsAvailableWidth) {
		sessionDetails = `${' '.repeat(detailsIndent)}${sessionCol1}${' '.repeat(detailsSpacing)}${sessionCol3}`;
	}

	const sessionDetailsPadded = sessionDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(sessionDetails)));

	// Claude usage limit message
	let usageLimitResetTimePadded: string | null = null;
	if (block.usageLimitResetTime !== undefined && now < block.usageLimitResetTime) {
		const resetTime = block.usageLimitResetTime?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: true }) ?? null;
		const usageLimitResetTime = resetTime !== null ? pc.red(`${drawEmoji('❌')} USAGE LIMIT. RESET AT ${resetTime}`) : '';
		usageLimitResetTimePadded = resetTime !== null ? usageLimitResetTime + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageLimitResetTime))) : null;
	}
	terminal.write(`${marginStr}│ ${sessionDetailsPadded}│\n`);
	if (usageLimitResetTimePadded !== null) {
		terminal.write(`${marginStr}│ ${usageLimitResetTimePadded}│\n`);
	}
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Usage section (always show)
	// Determine bar color based on percentage
	let barColor = pc.green;
	if (tokenPercent > 100) {
		barColor = pc.red;
	}
	else if (tokenPercent > 80) {
		barColor = pc.yellow;
	}

	// Create colored progress bar
	const usageBar = config.tokenLimit != null && config.tokenLimit > 0
		? createProgressBar(
				totalTokens,
				config.tokenLimit,
				barWidth,
				{
					showPercentage: false,
					fillChar: barColor('█'),
					emptyChar: pc.gray('░'),
					leftBracket: '[',
					rightBracket: ']',
				},
			)
		: `[${pc.green('█'.repeat(Math.floor(barWidth * 0.1)))}${pc.gray('░'.repeat(barWidth - Math.floor(barWidth * 0.1)))}]`;

	// Burn rate with better formatting
	const burnRate = calculateBurnRate(block);
	const rateIndicator = getRateIndicator(burnRate);

	// Build rate display helper
	const buildRateDisplay = (useShort: boolean): string => {
		if (burnRate == null) {
			return `${pc.bold('Burn Rate:')} N/A`;
		}
		const rateValue = Math.round(burnRate.tokensPerMinute);
		const formattedRate = useShort ? formatTokensShort(rateValue) : formatNumber(rateValue);
		return `${pc.bold('Burn Rate:')} ${formattedRate} token/min ${rateIndicator}`;
	};

	// Usage section
	const usageLabel = `${drawEmoji('🔥')}${pc.bold(' USAGE')}`;
	const usageLabelWidth = stringWidth(usageLabel);

	// Create usage bar string with pre-generated text
	const usageBarStr = `${usageLabel}${''.padEnd(Math.max(0, labelWidth - usageLabelWidth))} ${usageBar} ${usageRightText}`;

	// Prepare usage details - try with full numbers first
	// First try with full format
	let rateDisplay = buildRateDisplay(false);
	let usageCol1 = `${pc.gray('Tokens:')} ${formatTokenDisplay(totalTokens, false)} (${rateDisplay})`;
	let usageCol2 = config.tokenLimit != null && config.tokenLimit > 0
		? `${pc.gray('Limit:')} ${formatTokenDisplay(config.tokenLimit, false)} tokens`
		: '';
	const usageCol3 = `${pc.gray('Cost:')} ${formatCurrency(block.costUSD)}`;

	// Calculate total width needed
	let totalWidth = stringWidth(usageCol1);
	if (usageCol2.length > 0) {
		totalWidth += detailsSpacing + stringWidth(usageCol2);
	}
	totalWidth += detailsSpacing + stringWidth(usageCol3);

	// If doesn't fit, use two-line layout with short format
	let useTwoLineLayout = false;
	if (totalWidth > detailsAvailableWidth) {
		useTwoLineLayout = true;
		// Rebuild with short format for two-line layout
		rateDisplay = buildRateDisplay(true);
		usageCol1 = `${pc.gray('Tokens:')} ${formatTokenDisplay(totalTokens, true)} (${rateDisplay})`;
		if (usageCol2.length > 0) {
			usageCol2 = `${pc.gray('Limit:')} ${formatTokenDisplay(config.tokenLimit!, true)} tokens`;
		}
	}

	// Render usage bar
	const usageBarPadded = usageBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageBarStr)));
	terminal.write(`${marginStr}│ ${usageBarPadded}│\n`);

	// Render usage details (indented and aligned)
	if (useTwoLineLayout) {
		// Two-line layout: Tokens on first line, Limit & Cost on second line
		const usageDetailsLine1 = `${' '.repeat(detailsIndent)}${usageCol1}`;
		const usageDetailsLine1Padded = usageDetailsLine1 + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageDetailsLine1)));
		terminal.write(`${marginStr}│ ${usageDetailsLine1Padded}│\n`);

		let usageDetailsLine2: string;
		if (usageCol2.length > 0) {
			// Limit and Cost on second line
			usageDetailsLine2 = `${' '.repeat(detailsIndent)}${usageCol2}${' '.repeat(detailsSpacing)}${usageCol3}`;
		}
		else {
			// Just Cost on second line
			usageDetailsLine2 = `${' '.repeat(detailsIndent)}${usageCol3}`;
		}
		const usageDetailsLine2Padded = usageDetailsLine2 + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageDetailsLine2)));
		terminal.write(`${marginStr}│ ${usageDetailsLine2Padded}│\n`);
	}
	else {
		// Single-line layout
		let usageDetails: string;
		if (usageCol2.length > 0) {
			// Three columns: Tokens, Limit, Cost
			usageDetails = `${' '.repeat(detailsIndent)}${usageCol1}${' '.repeat(detailsSpacing)}${usageCol2}${' '.repeat(detailsSpacing)}${usageCol3}`;
		}
		else {
			// Two columns: Tokens, Cost (no limit)
			usageDetails = `${' '.repeat(detailsIndent)}${usageCol1}${' '.repeat(detailsSpacing)}${usageCol3}`;
		}

		const usageDetailsPadded = usageDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageDetails)));
		terminal.write(`${marginStr}│ ${usageDetailsPadded}│\n`);
	}

	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Projections section
	if (projection != null) {
		// Determine projection bar color
		let projBarColor = pc.green;
		if (projectedPercent > 100) {
			projBarColor = pc.red;
		}
		else if (projectedPercent > 80) {
			projBarColor = pc.yellow;
		}

		// Create projection bar
		const projectionBar = config.tokenLimit != null && config.tokenLimit > 0
			? createProgressBar(
					projection.totalTokens,
					config.tokenLimit,
					barWidth,
					{
						showPercentage: false,
						fillChar: projBarColor('█'),
						emptyChar: pc.gray('░'),
						leftBracket: '[',
						rightBracket: ']',
					},
				)
			: `[${pc.green('█'.repeat(Math.floor(barWidth * 0.15)))}${pc.gray('░'.repeat(barWidth - Math.floor(barWidth * 0.15)))}]`;

		const limitStatus = config.tokenLimit != null && config.tokenLimit > 0
			? (projectedPercent > 100
					? pc.red(`${drawEmoji('❌')} WILL EXCEED LIMIT`)
					: projectedPercent > 80
						? pc.yellow(`${drawEmoji('⚠️')} APPROACHING LIMIT`)
						: pc.green(`${drawEmoji('✓')} WITHIN LIMIT`))
			: pc.green(`${drawEmoji('✓')} ON TRACK`);

		// Projection section
		const projLabel = `${drawEmoji('📈')}${pc.bold(' PROJECTION')}`;
		const projLabelWidth = stringWidth(projLabel);

		// Create projection bar string with pre-generated text
		const projBarStr = `${projLabel}${''.padEnd(Math.max(0, labelWidth - projLabelWidth))} ${projectionBar} ${projectionRightText}`;
		const projBarPadded = projBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projBarStr)));
		terminal.write(`${marginStr}│ ${projBarPadded}│\n`);

		// Projection details (indented and aligned)
		// First try with full format
		const projCol1 = `${pc.gray('Status:')} ${limitStatus}`;
		let projCol2 = `${pc.gray('Tokens:')} ${formatTokenDisplay(projection.totalTokens, false)}`;
		const projCol3 = `${pc.gray('Cost:')} ${formatCurrency(projection.totalCost)}`;

		// Calculate total width needed
		const projTotalWidth = stringWidth(projCol1) + stringWidth(projCol2) + stringWidth(projCol3) + (detailsSpacing * 2);

		// If doesn't fit, use two-line layout with short format
		let projUseTwoLineLayout = false;
		if (projTotalWidth > detailsAvailableWidth) {
			projUseTwoLineLayout = true;
			// Rebuild with short format for two-line layout
			projCol2 = `${pc.gray('Tokens:')} ${formatTokenDisplay(projection.totalTokens, true)}`;
		}

		// Render projection details
		if (projUseTwoLineLayout) {
			// Two-line layout: Status on first line, Tokens & Cost on second line
			const projDetailsLine1 = `${' '.repeat(detailsIndent)}${projCol1}`;
			const projDetailsLine1Padded = projDetailsLine1 + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projDetailsLine1)));
			terminal.write(`${marginStr}│ ${projDetailsLine1Padded}│\n`);

			const projDetailsLine2 = `${' '.repeat(detailsIndent)}${projCol2}${' '.repeat(detailsSpacing)}${projCol3}`;
			const projDetailsLine2Padded = projDetailsLine2 + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projDetailsLine2)));
			terminal.write(`${marginStr}│ ${projDetailsLine2Padded}│\n`);
		}
		else {
			// Single-line layout with fixed 2-space separation
			const projDetails = `${' '.repeat(detailsIndent)}${projCol1}${' '.repeat(detailsSpacing)}${projCol2}${' '.repeat(detailsSpacing)}${projCol3}`;
			const projDetailsPadded = projDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projDetails)));
			terminal.write(`${marginStr}│ ${projDetailsPadded}│\n`);
		}

		terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	}

	// Models section
	if (block.models.length > 0) {
		terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
		const modelsLine = `${drawEmoji('⚙️')}  Models: ${formatModelsDisplay(block.models)}`;
		const modelsLinePadded = modelsLine + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(modelsLine)));
		terminal.write(`${marginStr}│ ${modelsLinePadded}│\n`);
	}

	// Footer
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	const refreshText = `${drawEmoji('↻')} Refreshing every ${config.refreshInterval / 1000}s  •  Press Ctrl+C to stop`;
	terminal.write(`${marginStr}│${pc.gray(centerText(refreshText, boxWidth - 2))}│\n`);
	terminal.write(`${marginStr}└${'─'.repeat(boxWidth - 2)}┘\n`);
}

/**
 * Renders a compact live display for narrow terminals
 */
export function renderCompactLiveDisplay(
	terminal: TerminalManager,
	block: SessionBlock,
	config: LiveMonitoringConfig,
	totalTokens: number,
	elapsed: number,
	remaining: number,
): void {
	const width = terminal.width;

	// Header
	terminal.write(`${pc.bold(centerText('LIVE MONITOR', width))}\n`);
	terminal.write(`${'─'.repeat(width)}\n`);

	// Session info
	const sessionPercent = (elapsed / (elapsed + remaining)) * 100;
	terminal.write(`Session: ${sessionPercent.toFixed(1)}% (${Math.floor(elapsed / 60)}h ${Math.floor(elapsed % 60)}m)\n`);

	// Token usage
	if (config.tokenLimit != null && config.tokenLimit > 0) {
		const tokenPercent = (totalTokens / config.tokenLimit) * 100;
		const status = tokenPercent > 100 ? pc.red('OVER') : tokenPercent > 80 ? pc.yellow('WARN') : pc.green('OK');
		terminal.write(`Tokens: ${formatNumber(totalTokens)}/${formatNumber(config.tokenLimit)} ${status}\n`);
	}
	else {
		terminal.write(`Tokens: ${formatNumber(totalTokens)}\n`);
	}

	// Cost
	terminal.write(`Cost: ${formatCurrency(block.costUSD)}\n`);

	// Burn rate
	const burnRate = calculateBurnRate(block);
	if (burnRate != null) {
		terminal.write(`Rate: ${formatNumber(burnRate.tokensPerMinute)}/min\n`);
	}

	// Footer
	terminal.write(`${'─'.repeat(width)}\n`);
	terminal.write(pc.gray(`Refresh: ${config.refreshInterval / 1000}s | Ctrl+C: stop\n`));
}

// In-source testing
if (import.meta.vitest != null) {
	describe('formatTokensShort', () => {
		it('should format numbers under 1000 as-is', () => {
			expect(formatTokensShort(999)).toBe('999');
			expect(formatTokensShort(0)).toBe('0');
		});

		it('should format numbers 1000+ with k suffix', () => {
			expect(formatTokensShort(1000)).toBe('1.0k');
			expect(formatTokensShort(1234)).toBe('1.2k');
			expect(formatTokensShort(15678)).toBe('15.7k');
		});
	});

	describe('getRateIndicator', () => {
		it('returns empty string for null burn rate', () => {
			const result = getRateIndicator(null);
			expect(result).toBe('');
		});

		it('returns HIGH for rates above 1000', () => {
			const burnRate = {
				tokensPerMinute: 2000,
				tokensPerMinuteForIndicator: 1500,
				costPerHour: 10,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('HIGH');
		});

		it('returns MODERATE for rates between 500 and 1000', () => {
			const burnRate = {
				tokensPerMinute: 1000,
				tokensPerMinuteForIndicator: 750,
				costPerHour: 5,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('MODERATE');
		});

		it('returns NORMAL for rates 500 and below', () => {
			const burnRate = {
				tokensPerMinute: 800,
				tokensPerMinuteForIndicator: 400,
				costPerHour: 2,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('NORMAL');
		});

		it('returns NORMAL for exactly 500 tokens per minute', () => {
			const burnRate = {
				tokensPerMinute: 1000,
				tokensPerMinuteForIndicator: 500,
				costPerHour: 3,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('NORMAL');
		});

		it('returns MODERATE for exactly 1000 tokens per minute (boundary)', () => {
			const burnRate = {
				tokensPerMinute: 2000,
				tokensPerMinuteForIndicator: 1000,
				costPerHour: 5,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('MODERATE'); // 1000 is not greater than 1000, but is greater than 500
		});

		it('returns HIGH for just above 1000 tokens per minute', () => {
			const burnRate = {
				tokensPerMinute: 2000,
				tokensPerMinuteForIndicator: 1001,
				costPerHour: 5,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('HIGH');
		});

		it('returns NORMAL for just below 500 tokens per minute', () => {
			const burnRate = {
				tokensPerMinute: 800,
				tokensPerMinuteForIndicator: 499,
				costPerHour: 2,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('NORMAL');
		});

		it('returns MODERATE for just above 500 tokens per minute', () => {
			const burnRate = {
				tokensPerMinute: 1000,
				tokensPerMinuteForIndicator: 501,
				costPerHour: 3,
			};
			const result = getRateIndicator(burnRate);
			expect(result).toContain('MODERATE');
		});
	});

	describe('delayWithAbort', () => {
		it('should complete normally without abort', async () => {
			const controller = new AbortController();
			const start = Date.now();
			await delayWithAbort(10, controller.signal);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(9);
		});

		it('should throw AbortError when signal is aborted', async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 5);

			await expect(delayWithAbort(50, controller.signal))
				.rejects
				.toThrow('This operation was aborted');
		});
	});
}
