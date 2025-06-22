import type { WriteStream } from 'node:tty';
import process from 'node:process';
import * as readline from 'node:readline';
import * as ansiEscapes from 'ansi-escapes';
import stringWidth from 'string-width';

/**
 * Manages terminal state for live updates
 * Provides a clean interface for terminal operations with automatic TTY checking
 * and cursor state management for live monitoring displays
 */
export class TerminalManager {
	private stream: WriteStream;
	private cursorHidden = false;

  private lastContentLines = 0;


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

			// Use readline to clear and reposition cursor
			readline.cursorTo(this.stream, 0, 0);
			readline.clearScreenDown(this.stream);
			// Reset line counter for next content
			this.lastContentLines = 0;
		}
	}

	/**
	 * Clears the previously written content by moving cursor up and clearing lines
	 */
	clearPreviousContent(): void {
		if (this.stream.isTTY && this.lastContentLines > 0) {
			// Move cursor up to beginning of previous content
			this.stream.write(`\u001B[${this.lastContentLines}A`);
			// Clear from cursor to end of screen
			this.stream.write('\u001B[0J');
			this.lastContentLines = 0;
		}
	}

	/**
	 * Clears the current line
	 */
	clearLine(): void {
		if (this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.CLEAR_LINE);
		}
	}

	/**
	 * Moves cursor up by n lines
	 */
	moveUp(lines: number): void {
		if (this.stream.isTTY && lines > 0) {
			this.stream.write(TERMINAL_CONTROL.MOVE_UP(lines));
		}
	}

	/**
	 * Moves cursor to beginning of line
	 */
	moveToLineStart(): void {
		if (this.stream.isTTY) {
			this.stream.write(TERMINAL_CONTROL.MOVE_TO_COLUMN(1));
		}
	}

	/**
	 * Writes text to the stream and tracks line count

			// Only clear screen in TTY environments to prevent issues with non-interactive streams
			this.stream.write(ansiEscapes.clearScreen);
			this.stream.write(ansiEscapes.cursorTo(0, 0));
		}
	}

	/**
	 * Writes text to the terminal stream
	 * Simple wrapper that could be removed, but kept for API consistency

	 */
	write(text: string): void {
		this.stream.write(text);
		// Count lines in the written text
		const lines = (text.match(/\n/g)?.length) ?? 0;
		this.lastContentLines += lines;
	}

	/**
	 * Writes text to the stream without tracking line count
	 */
	writeRaw(text: string): void {
		this.stream.write(text);
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
	 * Checks if the stream is connected to a real terminal (TTY)
	 * Used to avoid sending ANSI escape codes to files or pipes
	 */
	get isTTY(): boolean {
		return this.stream.isTTY ?? false;
	}

	/**
	 * Cleanup method to restore terminal state
	 * Always call this before program exit to show cursor again
	 */
	cleanup(): void {
		this.showCursor();
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
		bar += '\u001B[0m'; // Reset color
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
