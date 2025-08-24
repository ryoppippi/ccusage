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
import {
	clearLiveMonitorCache,
	createLiveMonitorState,
	getActiveBlock,
} from '../_live-monitor.ts';
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

	// Create live monitor state with efficient data loading
	const monitorConfig = {
		claudePaths: config.claudePaths,
		sessionDurationHours: config.sessionDurationHours,
		mode: config.mode,
		order: config.order,
	};
	using monitorState = createLiveMonitorState(monitorConfig);

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

				// Get latest data
				const activeBlock = await getActiveBlock(monitorState, monitorConfig);
				clearLiveMonitorCache(monitorState); // Clear cache for memory management

				if (activeBlock == null) {
					await renderWaitingState(terminal, config, abortController.signal);
					continue;
				}

				// Render active block
				renderActiveBlock(terminal, activeBlock, config);
				lastRenderTime = Date.now();

				// Wait before next refresh (refreshInterval passed, aborted, or terminal resized)
				let resizeEventHandler: undefined | ((value: unknown) => void);

				try {
					await Promise.race([
						delayWithAbort(config.refreshInterval, abortController.signal),
						new Promise((resolve) => {
							resizeEventHandler = resolve;
							process.stdout.once('resize', resolve);
						}),
					]);
				}
				finally {
					if (resizeEventHandler != null) {
						process.stdout.removeListener('resize', resizeEventHandler);
					}
				}
			}
		},
		catch: error => error,
	})();

	if (Result.isFailure(monitoringResult)) {
		const error = monitoringResult.error;
		if ((error instanceof DOMException || error instanceof Error) && error.name === 'AbortError') {
			return; // Normal graceful shutdown
		}

		// Handle and display errors
		const errorMessage = error instanceof Error ? error.message : String(error);
		terminal.startBuffering();
		terminal.clearScreen();
		terminal.write(pc.red(`Error: ${errorMessage}\n`));
		terminal.flush();
		logger.error(`Live monitoring error: ${errorMessage}`);
		await delayWithAbort(config.refreshInterval, abortController.signal).catch(() => {});
	}
}
