/**
 * @fileoverview Live monitoring command orchestration
 *
 * This module provides the command-line interface for live monitoring,
 * handling process lifecycle, signal management, and terminal setup.
 * The actual rendering logic is handled by the _live-rendering module.
 */

import type { LiveMonitoringConfig } from '../_live-rendering.ts';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import pc from 'picocolors';
import { MIN_RENDER_INTERVAL_MS } from '../_consts.ts';
import { LiveMonitor } from '../_live-monitor.ts';
import {
	delayWithAbort,
	renderActiveBlock,
	renderWaitingState,
} from '../_live-rendering.ts';
import { TerminalManager } from '../_terminal-utils.ts';
import { logger } from '../logger.ts';

export async function startLiveMonitoring(config: LiveMonitoringConfig): Promise<void> {
	const terminal = new TerminalManager();
	const abortController = new AbortController();
	let lastRenderTime = 0;

	// Setup graceful shutdown
	const cleanup = (): void => {
		abortController.abort();
		terminal.cleanup();
		terminal.clearScreen();
		logger.info('Live monitoring stopped.');
		if (process.exitCode == null) {
			process.exit(0);
		}
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);

	// Setup terminal for optimal TUI performance
	terminal.enterAlternateScreen();
	terminal.enableSyncMode();
	terminal.clearScreen();
	terminal.hideCursor();

	// Create live monitor with efficient data loading
	using monitor = new LiveMonitor({
		claudePath: config.claudePath,
		sessionDurationHours: config.sessionDurationHours,
		mode: config.mode,
		order: config.order,
	});

	const monitoringResult = await Result.try({
		try: async () => {
			while (!abortController.signal.aborted) {
				const now = Date.now();
				const timeSinceLastRender = now - lastRenderTime;

				// Skip render if too soon (frame rate limiting)
				if (timeSinceLastRender < MIN_RENDER_INTERVAL_MS) {
					await delayWithAbort(MIN_RENDER_INTERVAL_MS - timeSinceLastRender, abortController.signal);
					continue;
				}

				// Get latest data with error handling
				const blockResult = await Result.try({
					try: async () => monitor.getActiveBlock(),
					catch: (error) => error,
				})();

				if (Result.isFailure(blockResult)) {
					const error = blockResult.error;
					const errorMessage = error instanceof Error ? error.message : String(error);
					
					// Check if this is a file synchronization related error (ENOENT)
					const isSyncError = errorMessage.includes('ENOENT') || errorMessage.includes('no such file or directory');
					
					if (isSyncError) {
						// For sync-related errors, show a friendlier message and continue monitoring
						const friendlyMessage = 'File temporarily unavailable (likely due to cloud sync)';
						terminal.startBuffering();
						terminal.clearScreen();
						terminal.write(pc.yellow(`Warning: ${friendlyMessage}\n`));
						terminal.write(pc.dim('Waiting for file sync to complete...\n'));
						terminal.flush();
						logger.warn(`File sync issue detected: ${errorMessage}`);
						
						// Continue monitoring after a delay
						await delayWithAbort(config.refreshInterval, abortController.signal);
						continue;
					} else {
						// For other errors, re-throw to be handled by outer try-catch
						throw error;
					}
				}

				const activeBlock = blockResult.value;
				monitor.clearCache(); // TODO: debug LiveMonitor.getActiveBlock() efficiency

				if (activeBlock == null) {
					await renderWaitingState(terminal, config, abortController.signal);
					continue;
				}

				// Render active block
				renderActiveBlock(terminal, activeBlock, config);
				lastRenderTime = Date.now();

				// Wait before next refresh
				await delayWithAbort(config.refreshInterval, abortController.signal);
			}
		},
		catch: error => error,
	})();

	if (Result.isFailure(monitoringResult)) {
		const error = monitoringResult.error;
		if ((error instanceof DOMException || error instanceof Error) && error.name === 'AbortError') {
			return; // Normal graceful shutdown
		}

		// Handle non-sync errors that caused the monitoring loop to exit
		const errorMessage = error instanceof Error ? error.message : String(error);
		terminal.startBuffering();
		terminal.clearScreen();
		terminal.write(pc.red(`Error: ${errorMessage}\n`));
		terminal.flush();
		logger.error(`Live monitoring error: ${errorMessage}`);
		
		await delayWithAbort(config.refreshInterval, abortController.signal).catch(() => {});
	}
}
