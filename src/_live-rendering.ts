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
import { delay } from '@jsr/std__async/delay';
import * as ansiEscapes from 'ansi-escapes';
import pc from 'picocolors';
import prettyMs from 'pretty-ms';
import stringWidth from 'string-width';
import { calculateBurnRate, projectBlockUsage } from './_session-blocks.ts';
import { centerText, createProgressBar } from './_terminal-utils.ts';
import { formatCurrency, formatModelsDisplay, formatNumber } from './_utils.ts';

/**
 * Live monitoring configuration
 */
export type LiveMonitoringConfig = {
	claudePath: string;
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
 * Column layout constants for detail rows
 */
const DETAIL_COLUMN_WIDTHS = {
	col1: 46, // First column width (e.g., "Tokens: 12,345 (50 per min ✓ NORMAL)")
	col2: 37, // Second column width (e.g., "Limit: 60,000 tokens")
} as const;

/**
 * Renders the live display for an active session block
 */
export function renderLiveDisplay(terminal: TerminalManager, block: SessionBlock, config: LiveMonitoringConfig): void {
	const width = terminal.width;
	const now = new Date();

	// Calculate key metrics
	const totalTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
	const elapsed = (now.getTime() - block.startTime.getTime()) / (1000 * 60);
	const remaining = (block.endTime.getTime() - now.getTime()) / (1000 * 60);

	// Use compact mode for narrow terminals
	if (width < 60) {
		renderCompactLiveDisplay(terminal, block, config, totalTokens, elapsed, remaining);
		return;
	}

	// Calculate box dimensions - use full width with minimal margins
	const boxWidth = Math.min(120, width - 2); // Use almost full width, leaving 1 char margin on each side
	const boxMargin = Math.floor((width - boxWidth) / 2);
	const marginStr = ' '.repeat(boxMargin);

	// Calculate progress bar width - fill most of the box
	const labelWidth = 14; // Width for labels like "SESSION"
	const percentWidth = 7; // Width for percentage display
	const shortLabelWidth = 20; // For (XXX.Xk/XXX.Xk) format
	const barWidth = boxWidth - labelWidth - percentWidth - shortLabelWidth - 4; // spacing

	// Session progress
	const sessionDuration = elapsed + remaining;
	const sessionPercent = (elapsed / sessionDuration) * 100;
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

	// Draw header
	terminal.write(`${marginStr}┌${'─'.repeat(boxWidth - 2)}┐\n`);
	terminal.write(`${marginStr}│${pc.bold(centerText('CLAUDE CODE - LIVE TOKEN USAGE MONITOR', boxWidth - 2))}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Session section
	const sessionLabel = pc.bold('⏱️ SESSION');
	const sessionLabelWidth = stringWidth(sessionLabel);
	const sessionBarStr = `${sessionLabel}${''.padEnd(Math.max(0, labelWidth - sessionLabelWidth))} ${sessionProgressBar} ${sessionPercent.toFixed(1).padStart(6)}%`;
	const sessionBarPadded = sessionBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(sessionBarStr)));
	terminal.write(`${marginStr}│ ${sessionBarPadded}│\n`);

	// Session details (indented)
	const col1 = `${pc.gray('Started:')} ${startTime}`;
	const col2 = `${pc.gray('Elapsed:')} ${Math.floor(elapsed / 60)}h ${Math.floor(elapsed % 60)}m`;
	const col3 = `${pc.gray('Remaining:')} ${Math.floor(remaining / 60)}h ${Math.floor(remaining % 60)}m (${endTime})`;
	// Calculate actual visible lengths without ANSI codes
	const col1Visible = stringWidth(col1);
	const col2Visible = stringWidth(col2);
	// Fixed column positions - aligned with proper spacing
	const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
	const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
	const sessionDetails = `   ${col1}${pad1}${pad2}${col3}`;
	const sessionDetailsPadded = sessionDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(sessionDetails)));
	// Claude usage limit message
	let usageLimitResetTimePadded: string | null = null;
	if (block.usageLimitResetTime !== undefined && now < block.usageLimitResetTime) {
		const resetTime = block.usageLimitResetTime?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: true }) ?? null;
		const usageLimitResetTime = resetTime !== null ? pc.red(`❌ USAGE LIMIT. RESET AT ${resetTime}`) : '';
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
	const tokenPercent = config.tokenLimit != null && config.tokenLimit > 0
		? (totalTokens / config.tokenLimit) * 100
		: 0;

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
	const rateIndicator = burnRate != null
		? (burnRate.tokensPerMinute > 1000 ? pc.red('⚡ HIGH') : burnRate.tokensPerMinute > 500 ? pc.yellow('⚡ MODERATE') : pc.green('✓ NORMAL'))
		: '';
	const rateDisplay = burnRate != null
		? `${pc.bold('Burn Rate:')} ${Math.round(burnRate.tokensPerMinute)} token/min ${rateIndicator}`
		: `${pc.bold('Burn Rate:')} N/A`;

	// Usage section
	const usageLabel = pc.bold('🔥 USAGE');
	const usageLabelWidth = stringWidth(usageLabel);

	// Prepare usage bar string and details based on token limit availability
	// Using const destructuring pattern instead of let/reassignment to avoid side effects
	// This creates immutable values based on the condition, improving code clarity
	const { usageBarStr, usageCol1, usageCol2, usageCol3 } = config.tokenLimit != null && config.tokenLimit > 0
		? {
				usageBarStr: `${usageLabel}${''.padEnd(Math.max(0, labelWidth - usageLabelWidth))} ${usageBar} ${tokenPercent.toFixed(1).padStart(6)}% (${formatTokensShort(totalTokens)}/${formatTokensShort(config.tokenLimit)})`,
				usageCol1: `${pc.gray('Tokens:')} ${formatNumber(totalTokens)} (${rateDisplay})`,
				usageCol2: `${pc.gray('Limit:')} ${formatNumber(config.tokenLimit)} tokens`,
				usageCol3: `${pc.gray('Cost:')} ${formatCurrency(block.costUSD)}`,
			}
		: {
				usageBarStr: `${usageLabel}${''.padEnd(Math.max(0, labelWidth - usageLabelWidth))} ${usageBar} (${formatTokensShort(totalTokens)} tokens)`,
				usageCol1: `${pc.gray('Tokens:')} ${formatNumber(totalTokens)} (${rateDisplay})`,
				usageCol2: '',
				usageCol3: `${pc.gray('Cost:')} ${formatCurrency(block.costUSD)}`,
			};

	// Render usage bar
	const usageBarPadded = usageBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageBarStr)));
	terminal.write(`${marginStr}│ ${usageBarPadded}│\n`);

	// Render usage details (indented and aligned)
	const usageCol1Visible = stringWidth(usageCol1);
	const usageCol2Visible = stringWidth(usageCol2);
	const usagePad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - usageCol1Visible));
	const usagePad2 = usageCol2.length > 0 ? ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - usageCol2Visible)) : ' '.repeat(DETAIL_COLUMN_WIDTHS.col2);
	const usageDetails = `   ${usageCol1}${usagePad1}${usageCol2}${usagePad2}${usageCol3}`;
	const usageDetailsPadded = usageDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(usageDetails)));
	terminal.write(`${marginStr}│ ${usageDetailsPadded}│\n`);

	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);

	// Projections section
	const projection = projectBlockUsage(block);
	if (projection != null) {
		const projectedPercent = config.tokenLimit != null && config.tokenLimit > 0
			? (projection.totalTokens / config.tokenLimit) * 100
			: 0;

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
					? pc.red('❌ WILL EXCEED LIMIT')
					: projectedPercent > 80
						? pc.yellow('⚠️  APPROACHING LIMIT')
						: pc.green('✓ WITHIN LIMIT'))
			: pc.green('✓ ON TRACK');

		// Projection section
		const projLabel = pc.bold('📈 PROJECTION');
		const projLabelWidth = stringWidth(projLabel);
		if (config.tokenLimit != null && config.tokenLimit > 0) {
			const projBarStr = `${projLabel}${''.padEnd(Math.max(0, labelWidth - projLabelWidth))} ${projectionBar} ${projectedPercent.toFixed(1).padStart(6)}% (${formatTokensShort(projection.totalTokens)}/${formatTokensShort(config.tokenLimit)})`;
			const projBarPadded = projBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projBarStr)));
			terminal.write(`${marginStr}│ ${projBarPadded}│\n`);

			// Projection details (indented and aligned)
			const col1 = `${pc.gray('Status:')} ${limitStatus}`;
			const col2 = `${pc.gray('Tokens:')} ${formatNumber(projection.totalTokens)}`;
			const col3 = `${pc.gray('Cost:')} ${formatCurrency(projection.totalCost)}`;
			// Calculate visible lengths (without ANSI codes)
			const col1Visible = stringWidth(col1);
			const col2Visible = stringWidth(col2);
			// Fixed column positions - match session alignment
			const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
			const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
			const projDetails = `   ${col1}${pad1}${col2}${pad2}${col3}`;
			const projDetailsPadded = projDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projDetails)));
			terminal.write(`${marginStr}│ ${projDetailsPadded}│\n`);
		}
		else {
			const projBarStr = `${projLabel}${''.padEnd(Math.max(0, labelWidth - projLabelWidth))} ${projectionBar} (${formatTokensShort(projection.totalTokens)} tokens)`;
			const projBarPadded = projBarStr + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projBarStr)));
			terminal.write(`${marginStr}│ ${projBarPadded}│\n`);

			// Projection details (indented)
			const col1 = `${pc.gray('Status:')} ${limitStatus}`;
			const col2 = `${pc.gray('Tokens:')} ${formatNumber(projection.totalTokens)}`;
			const col3 = `${pc.gray('Cost:')} ${formatCurrency(projection.totalCost)}`;
			// Calculate visible lengths
			const col1Visible = stringWidth(col1);
			const col2Visible = stringWidth(col2);
			// Fixed column positions - match session alignment
			const pad1 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col1 - col1Visible));
			const pad2 = ' '.repeat(Math.max(0, DETAIL_COLUMN_WIDTHS.col2 - col2Visible));
			const projDetails = `   ${col1}${pad1}${col2}${pad2}${col3}`;
			const projDetailsPadded = projDetails + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(projDetails)));
			terminal.write(`${marginStr}│ ${projDetailsPadded}│\n`);
		}

		terminal.write(`${marginStr}│${' '.repeat(boxWidth - 2)}│\n`);
	}

	// Models section
	if (block.models.length > 0) {
		terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
		const modelsLine = `⚙️  Models: ${formatModelsDisplay(block.models)}`;
		const modelsLinePadded = modelsLine + ' '.repeat(Math.max(0, boxWidth - 3 - stringWidth(modelsLine)));
		terminal.write(`${marginStr}│ ${modelsLinePadded}│\n`);
	}

	// Footer
	terminal.write(`${marginStr}├${'─'.repeat(boxWidth - 2)}┤\n`);
	const refreshText = `↻ Refreshing every ${config.refreshInterval / 1000}s  •  Press Ctrl+C to stop`;
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
	terminal.write(`Session: ${sessionPercent.toFixed(1)}% (${Math.floor(elapsed / 60)}h ${Math.floor(elapsed % 60)}m elapsed)\n`);
	terminal.write(`Remaining: ${Math.floor(remaining / 60)}h ${Math.floor(remaining % 60)}m\n`);

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
