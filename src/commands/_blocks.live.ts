/**
 * @fileoverview Live monitoring command orchestration
 *
 * This module provides the command-line interface for live monitoring,
 * handling process lifecycle, signal management, and terminal setup.
 * The actual rendering logic is handled by the _live-rendering module.
 */

import type { LiveMonitoringConfig } from '../_live-rendering.ts';
import process from 'node:process';
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

	try {
		while (!abortController.signal.aborted) {
			const now = Date.now();
			const timeSinceLastRender = now - lastRenderTime;

			// Skip render if too soon (frame rate limiting)
			if (timeSinceLastRender < MIN_RENDER_INTERVAL_MS) {
				await delayWithAbort(MIN_RENDER_INTERVAL_MS - timeSinceLastRender, abortController.signal);
				continue;
			}

			// Get latest data
			const activeBlock = await monitor.getActiveBlock();
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
	}
	catch (error) {
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
