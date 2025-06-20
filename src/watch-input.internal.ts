import type { SessionBlock } from './session-blocks.internal.ts';
import type { DisplayOptions } from './types.internal.ts';
import process from 'node:process';
import pc from 'picocolors';
import { log } from './logger.ts';
import { clearScreen, formatCurrency, formatDuration, formatNumber } from './utils.internal.ts';

/**
 * Creates a cleanup handler function for the watch command
 * @param intervalId - Reference object containing the timer interval ID to clear
 * @param intervalId.current - The actual timer interval ID
 * @param sessionStartTime - When the session started
 * @param sessionStartTokens - Initial token count
 * @param sessionStartCost - Initial cost
 * @param activeBlockForSummary - Reference to active block for summary
 * @param activeBlockForSummary.current - The actual active block
 * @returns Cleanup function
 */
export function createCleanupHandler(
	intervalId: { current: NodeJS.Timeout | null },
	sessionStartTime: Date,
	sessionStartTokens: number,
	sessionStartCost: number,
	activeBlockForSummary: { current: SessionBlock | null },
): () => void {
	return (): void => {
		if (intervalId.current != null) {
			clearTimeout(intervalId.current);
		}
		process.stdin.setRawMode(false);
		process.stdin.pause();
		clearScreen();

		// Calculate session duration
		const sessionEndTime = new Date();
		const durationMs = sessionEndTime.getTime() - sessionStartTime.getTime();
		const durationMinutes = Math.floor(durationMs / (1000 * 60));
		const durationSeconds = Math.floor(durationMs / 1000);

		const durationText = formatDuration(durationMinutes, durationSeconds);

		// Calculate tokens and cost used during this session
		let tokensUsed = 0;
		let costUsed = 0;

		if (activeBlockForSummary.current != null) {
			const currentTokens = activeBlockForSummary.current.tokenCounts.inputTokens + activeBlockForSummary.current.tokenCounts.outputTokens;
			tokensUsed = currentTokens - sessionStartTokens;
			costUsed = activeBlockForSummary.current.costUSD - sessionStartCost;
		}

		log(pc.cyan(`Duration: ${durationText} | Tokens: ${formatNumber(tokensUsed)} | Cost: ${formatCurrency(costUsed)}`));
		process.exit(0);
	};
}

/**
 * Sets up keyboard input handling for the watch command
 * @param displayOptions - Display options that can be toggled
 * @param updateDisplay - Function to call when display needs updating
 * @param cleanup - Cleanup function to call on exit
 */
export function setupKeyboardHandling(
	displayOptions: DisplayOptions,
	updateDisplay: () => Promise<void>,
	cleanup: () => void,
): void {
	// Setup keyboard input handling
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding('utf8');

	// Handle keyboard input
	const handleKeyPress = (key: string): void => {
		// Exit keys
		if (key === '\u001B' || key === '\u0003') { // ESC or Ctrl+C
			cleanup();
			return;
		}

		// Toggle display options
		const keyLower = key.toLowerCase();
		let needsUpdate = false;

		if (keyLower === 'p') {
			displayOptions.showPeriod = !displayOptions.showPeriod;
			needsUpdate = true;
		}
		else if (keyLower === 't') {
			displayOptions.showTokens = !displayOptions.showTokens;
			needsUpdate = true;
		}
		else if (keyLower === 'c') {
			displayOptions.showCost = !displayOptions.showCost;
			needsUpdate = true;
		}

		if (needsUpdate) {
			updateDisplay().catch((error: unknown) => {
				console.error('Update display error:', error);
			});
		}
	};

	process.stdin.on('data', handleKeyPress);

	// Handle Ctrl+C gracefully (fallback)
	process.on('SIGINT', cleanup);
}
