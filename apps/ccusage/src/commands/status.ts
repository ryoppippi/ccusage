import process from 'node:process';
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
	},
	toKebab: true,
	async run(ctx) {
		const useJson = Boolean(ctx.values.json);
		if (useJson) {
			logger.level = 0;
		}

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

			// Get color formatter based on status
			const colorFormatter = getStatusColor(indicator, description);
			const styledStatus = colorFormatter(description);

			log(`Claude Status: ${styledStatus} - ${status.page.url}`);
		}
	},
});
