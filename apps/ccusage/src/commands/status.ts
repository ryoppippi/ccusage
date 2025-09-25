import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import { fetchClaudeStatus, getStatusColor } from '../_claude-status-api.ts';
import { sharedArgs } from '../_shared-args.ts';
import { log, logger } from '../logger.ts';

export const statusCommand = define({
	name: 'status',
	description: 'Show Claude service status',
	args: {
		json: sharedArgs.json,
		color: sharedArgs.color,
		noColor: sharedArgs.noColor,
	},
	toKebab: true,
	async run(ctx) {
		const useJson = Boolean(ctx.values.json);
		if (useJson) {
			logger.level = 0;
		}

		// Determine color preference from flags
		let enableColors: boolean | undefined;
		if (ctx.values.color === true) {
			enableColors = true;
		}
		else if (ctx.values.noColor === true) {
			enableColors = false;
		}
		// Otherwise, leave undefined to use auto-detection

		const statusResult = await fetchClaudeStatus();

		if (Result.isFailure(statusResult)) {
			const error = statusResult.error;
			const errorMessage = `Failed to fetch Claude status: ${error.message}`;

			if (useJson) {
				log(JSON.stringify({
					error: error.message,
					success: false,
				}));
			}
			else {
				logger.error(errorMessage);
			}

			throw error;
		}

		const status = statusResult.value;

		if (useJson) {
			log(JSON.stringify(status, null, 2));
		}
		else {
			// Format the status description with appropriate styling
			const description = status.status.description;
			const indicator = status.status.indicator;

			// Get color formatter based on status and color preference
			const colorFormatter = getStatusColor(indicator, description, enableColors);
			const styledStatus = colorFormatter(description);

			log(`Claude Status: ${styledStatus} - ${status.page.url}`);
		}
	},
});

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('statusCommand', () => {
		it('should have correct command definition', () => {
			expect(statusCommand.name).toBe('status');
			expect(statusCommand.description).toBe('Show Claude service status');
			expect(statusCommand.args?.json).toBeDefined();
			expect(statusCommand.args?.color).toBeDefined();
			expect(statusCommand.args?.noColor).toBeDefined();
		});
	});
}
