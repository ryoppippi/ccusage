import type { DisplayOptions } from '../types.internal.ts';
import process from 'node:process';
import { define } from 'gunshi';
import { logger } from '../logger.ts';
import { DEFAULT_SESSION_DURATION_HOURS } from '../session-blocks.internal.ts';
import { createSessionTracker } from '../session-tracker.internal.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import { createUpdateDisplay, UPDATE_INTERVALS, type UpdateDisplayConfig, type UpdateDisplayState } from '../watch-display.internal.ts';
import { createCleanupHandler, setupKeyboardHandling } from '../watch-input.internal.ts';
import { createAdaptiveScheduler } from '../watch-scheduler.internal.ts';

export const watchCommand = define({
	name: 'watch',
	description: 'Watch active session block usage with real-time updates and progress bars',
	args: {
		...sharedCommandConfig.args,
		sessionLength: {
			type: 'number',
			short: 'l',
			description: `Session block duration in hours (default: ${DEFAULT_SESSION_DURATION_HOURS})`,
			default: DEFAULT_SESSION_DURATION_HOURS,
		},
	},
	toKebab: true,
	async run(ctx) {
		// Force silent logger for clean display
		logger.level = 0;

		// Validate session length
		if (ctx.values.sessionLength != null && ctx.values.sessionLength <= 0) {
			console.error('Session length must be a positive number');
			process.exit(1);
		}

		// Setup state management
		const displayOptions: DisplayOptions = { showPeriod: false, showTokens: false, showCost: false };
		const sessionStartTime = new Date();
		const sessionTracker = createSessionTracker();

		// State for update display function
		const state: UpdateDisplayState = {
			previousState: { current: null },
			currentInterval: { current: UPDATE_INTERVALS.FAST },
			lastChangeTime: { current: new Date() },
			sessionTracker,
			activeBlockForSummary: { current: null },
		};

		// Configuration for update display function
		const updateConfig: UpdateDisplayConfig = {
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode ?? 'auto',
			order: ctx.values.order,
			sessionLength: ctx.values.sessionLength,
		};

		// Create update display function
		const updateDisplay = createUpdateDisplay(updateConfig, state, displayOptions);

		// Initial display
		await updateDisplay();

		// Setup adaptive scheduler
		const scheduler = createAdaptiveScheduler(updateDisplay, state.currentInterval);

		// Start the scheduler
		scheduler.start();

		// Create cleanup handler
		const cleanup = createCleanupHandler(
			scheduler.intervalId,
			sessionStartTime,
			sessionTracker.startTokens,
			sessionTracker.startCost,
			state.activeBlockForSummary,
		);

		// Setup keyboard handling
		setupKeyboardHandling(displayOptions, updateDisplay, cleanup);
	},
});
