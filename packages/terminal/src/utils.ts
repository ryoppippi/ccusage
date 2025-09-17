import type { WriteStream } from 'node:tty';
import process from 'node:process';
import * as ansiEscapes from 'ansi-escapes';
import stringWidth from 'string-width';

// DEC synchronized output mode - prevents screen flickering by buffering all terminal writes
// until flush() is called. Think of it like double-buffering in graphics programming.
// Reference: https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
const SYNC_START = '\x1B[?2026h'; // Start sync mode
const SYNC_END = '\x1B[?2026l'; // End sync mode

// Line wrap control sequences
const DISABLE_LINE_WRAP = '\x1B[?7l'; // Disable automatic line wrapping
const ENABLE_LINE_WRAP = '\x1B[?7h'; // Enable automatic line wrapping

// ANSI reset sequence
const ANSI_RESET = '\u001B[0m'; // Reset all formatting and colors

/**
 * Manages terminal state for live updates
 * Provides a clean interface for terminal operations with automatic TTY checking
 * and cursor state management for live monitoring displays
 */
export class TerminalManager {
	private stream: WriteStream;
	private cursorHidden = false;
	private buffer: string[] = [];
	private useBuffering = false;
	private alternateScreenActive = false;
	private syncMode = false;

	constructor(stream: WriteStream = process.stdout) {
		this.stream = stream;
	}

	/**
	 * Hides the terminal cursor for cleaner live updates
	 * Only works in TTY environments (real terminals)
	 */
	hideCursor(): void {
		if (!this.cursorHidden && this.stream.isTTY) {
			// Only hide cursor in TTY environments to prevent issues with non-interactive streams
			this.stream.write(ansiEscapes.cursorHide);
			this.cursorHidden = true;
		}
	}

	/**
	 * Shows the terminal cursor
	 * Should be called during cleanup to restore normal terminal behavior
	 */
	showCursor(): void {
		if (this.cursorHidden && this.stream.isTTY) {
			this.stream.write(ansiEscapes.cursorShow);
			this.cursorHidden = false;
		}
	}

	/**
	 * Clears the entire screen and moves cursor to top-left corner
	 * Essential for live monitoring displays that need to refresh completely
	 */
	clearScreen(): void {
		if (this.stream.isTTY) {
			// Only clear screen in TTY environments to prevent issues with non-interactive streams
			this.stream.write(ansiEscapes.clearScreen);
			this.stream.write(ansiEscapes.cursorTo(0, 0));
		}
	}

	/**
	 * Writes text to the terminal stream
	 * Supports buffering mode for performance optimization
	 */
	write(text: string): void {
		if (this.useBuffering) {
			this.buffer.push(text);
		}
		else {
			this.stream.write(text);
		}
	}

	/**
	 * Enables buffering mode - collects all writes in memory instead of sending immediately
	 * This prevents flickering when doing many rapid updates
	 */
	startBuffering(): void {
		this.useBuffering = true;
		this.buffer = [];
	}

	/**
	 * Sends all buffered content to terminal at once
	 * This creates smooth, atomic updates without flickering
	 */
	flush(): void {
		if (this.useBuffering && this.buffer.length > 0) {
			// Wrap output in sync mode for truly atomic screen updates
			if (this.syncMode && this.stream.isTTY) {
				this.stream.write(SYNC_START + this.buffer.join('') + SYNC_END);
			}
			else {
				this.stream.write(this.buffer.join(''));
			}
			this.buffer = [];
		}
		this.useBuffering = false;
	}

	/**
	 * Switches to alternate screen buffer (like vim/less does)
	 * This preserves what was on screen before and allows full-screen apps
	 */
	enterAlternateScreen(): void {
		if (!this.alternateScreenActive && this.stream.isTTY) {
			this.stream.write(ansiEscapes.enterAlternativeScreen);
			// Turn off line wrapping to prevent text from breaking badly
			this.stream.write(DISABLE_LINE_WRAP);
			this.alternateScreenActive = true;
		}
	}

	/**
	 * Returns to normal screen, restoring what was there before
	 */
	exitAlternateScreen(): void {
		if (this.alternateScreenActive && this.stream.isTTY) {
			// Re-enable line wrap
			this.stream.write(ENABLE_LINE_WRAP);
			this.stream.write(ansiEscapes.exitAlternativeScreen);
			this.alternateScreenActive = false;
		}
	}

	/**
	 * Enables sync mode - terminal will wait for END signal before showing updates
	 * Prevents the user from seeing partial/torn screen updates
	 */
	enableSyncMode(): void {
		this.syncMode = true;
	}

	/**
	 * Disables synchronized output mode
	 */
	disableSyncMode(): void {
		this.syncMode = false;
	}

	/**
	 * Gets terminal width in columns
	 * Falls back to 80 columns if detection fails
	 */
	get width(): number {
		return this.stream.columns || 80;
	}

	/**
	 * Gets terminal height in rows
	 * Falls back to 24 rows if detection fails
	 */
	get height(): number {
		return this.stream.rows || 24;
	}

	/**
	 * Returns true if output goes to a real terminal (not a file or pipe)
	 * We only send fancy ANSI codes to real terminals
	 */
	get isTTY(): boolean {
		return this.stream.isTTY ?? false;
	}

	/**
	 * Restores terminal to normal state - MUST call before program exits
	 * Otherwise user's terminal might be left in a broken state
	 */
	cleanup(): void {
		this.showCursor();
		this.exitAlternateScreen();
		this.disableSyncMode();
	}
}

/**
 * Creates a progress bar string with customizable appearance
 *
 * Example: createProgressBar(75, 100, 20) -> "[████████████████░░░░] 75.0%"
 *
 * @param value - Current progress value
 * @param max - Maximum value (100% point)
 * @param width - Character width of the progress bar (excluding brackets and text)
 * @param options - Customization options for appearance and display
 * @param options.showPercentage - Whether to show percentage after the bar
 * @param options.showValues - Whether to show current/max values
 * @param options.fillChar - Character for filled portion (default: '█')
 * @param options.emptyChar - Character for empty portion (default: '░')
 * @param options.leftBracket - Left bracket character (default: '[')
 * @param options.rightBracket - Right bracket character (default: ']')
 * @param options.colors - Color configuration for different thresholds
 * @param options.colors.low - Color for low percentage values
 * @param options.colors.medium - Color for medium percentage values
 * @param options.colors.high - Color for high percentage values
 * @param options.colors.critical - Color for critical percentage values
 * @returns Formatted progress bar string with optional percentage/values
 */
export function createProgressBar(
	value: number,
	max: number,
	width: number,
	options: {
		showPercentage?: boolean;
		showValues?: boolean;
		fillChar?: string;
		emptyChar?: string;
		leftBracket?: string;
		rightBracket?: string;
		colors?: {
			low?: string;
			medium?: string;
			high?: string;
			critical?: string;
		};
	} = {},
): string {
	const {
		showPercentage = true,
		showValues = false,
		fillChar = '█',
		emptyChar = '░',
		leftBracket = '[',
		rightBracket = ']',
		colors = {},
	} = options;

	const percentage = max > 0 ? Math.min(100, (value / max) * 100) : 0;
	const fillWidth = Math.round((percentage / 100) * width);
	const emptyWidth = width - fillWidth;

	// Determine color based on percentage
	let color = '';
	if (colors.critical != null && percentage >= 90) {
		color = colors.critical;
	}
	else if (colors.high != null && percentage >= 80) {
		color = colors.high;
	}
	else if (colors.medium != null && percentage >= 50) {
		color = colors.medium;
	}
	else if (colors.low != null) {
		color = colors.low;
	}

	// Build progress bar
	let bar = leftBracket;
	if (color !== '') {
		bar += color;
	}
	bar += fillChar.repeat(fillWidth);
	bar += emptyChar.repeat(emptyWidth);
	if (color !== '') {
		bar += ANSI_RESET; // Reset color
	}
	bar += rightBracket;

	// Add percentage or values
	if (showPercentage) {
		bar += ` ${percentage.toFixed(1)}%`;
	}
	if (showValues) {
		bar += ` (${value}/${max})`;
	}

	return bar;
}

/**
 * Centers text within a specified width using spaces for padding
 *
 * Uses string-width to handle Unicode characters and ANSI escape codes properly.
 * If text is longer than width, returns original text without truncation.
 *
 * Example: centerText("Hello", 10) -> "  Hello   "
 *
 * @param text - Text to center (may contain ANSI color codes)
 * @param width - Total character width including padding
 * @returns Text with spaces added for centering
 */
export function centerText(text: string, width: number): string {
	const textLength = stringWidth(text);
	if (textLength >= width) {
		return text;
	}

	const leftPadding = Math.floor((width - textLength) / 2);
	const rightPadding = width - textLength - leftPadding;

	return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
}

// Using below sequences causes issues in some terminals such as NeoVim.
// - ansiEscapes.cursorSavePosition (\u001B[s = Save Cursor)
// - ansiEscapes.cursorRestorePosition (\u001B[u = Unsave Cursor)
//
// Instead, we use:
// - \u001B7 = Save Cursor & Attrs
// - \u001B8 = Restore Cursor & Attrs
//
// see: https://www2.ccs.neu.edu/research/gpc/VonaUtils/vona/terminal/vtansi.htm
const SAVE_CURSOR = '\u001B7';
const RESTORE_CURSOR = '\u001B8';
/**
 * Draws an emoji with consistent 2-character width regardless of terminal behavior
 * @param emoji The emoji to draw
 * @returns A string containing ANSI escape sequences and the emoji
 */
export function drawEmoji(emoji: string): string {
	return `${SAVE_CURSOR}${emoji}${RESTORE_CURSOR}${ansiEscapes.cursorForward(stringWidth(emoji))}`;
}

if (import.meta.vitest != null) {
	describe('drawEmoji', () => {
		it('should always return a string with width as same as original', () => {
			// 2-width emojis
			expect(stringWidth(drawEmoji('⏱️'))).toBe(2);
			expect(stringWidth(drawEmoji('🔥'))).toBe(2);
			expect(stringWidth(drawEmoji('📈'))).toBe(2);
			expect(stringWidth(drawEmoji('⚙️'))).toBe(2);
			expect(stringWidth(drawEmoji('❌'))).toBe(2);
			expect(stringWidth(drawEmoji('⚠️'))).toBe(2);
			expect(stringWidth(drawEmoji('⚡'))).toBe(2);

			// 1-width emojis
			expect(stringWidth(drawEmoji('✓'))).toBe(1);
			expect(stringWidth(drawEmoji('↻'))).toBe(1);
		});
	});
}
