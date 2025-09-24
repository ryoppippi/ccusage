import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { fetchClaudeStatus } from '../_claude-status-api.ts';
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

		const statusResult = await fetchClaudeStatus();

		if (!statusResult.success) {
			const errorMessage = `Failed to fetch Claude status: ${statusResult.error.message}`;

			if (useJson) {
				log(JSON.stringify({
					error: statusResult.error.message,
					success: false,
				}));
			}
			else {
				logger.error(errorMessage);
			}

			process.exit(1);
		}

		const status = statusResult.value;

		if (useJson) {
			log(JSON.stringify(status, null, 2));
		}
		else {
			// Format the status description with appropriate styling
			const description = status.status.description;
			const indicator = status.status.indicator;

			// Style the status based on common status indicators
			let styledStatus = description;
			if (indicator === 'none' || description.toLowerCase().includes('operational')) {
				styledStatus = pc.green(description);
			}
			else if (indicator === 'minor' || description.toLowerCase().includes('degraded')) {
				styledStatus = pc.yellow(description);
			}
			else if (indicator === 'major' || indicator === 'critical' || description.toLowerCase().includes('outage')) {
				styledStatus = pc.red(description);
			}

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
