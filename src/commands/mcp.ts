import { define } from 'gunshi';
import { sharedArgs } from '../_shared-args.ts';
import { getClaudePaths } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { createMcpServer, startMcpServerStdio } from '../mcp.ts';

/**
 * MCP server command that provides stdio transport for usage reporting tools.
 * Allows starting an MCP server for external integrations with CLI applications.
 */
export const mcpCommand = define({
	name: 'mcp',
	description: 'Start MCP server with usage reporting tools (stdio only)',
	args: {
		mode: sharedArgs.mode,
	},
	async run(ctx) {
		const { mode } = ctx.values;
		// disable info logging for stdio
		logger.level = 0;

		const paths = getClaudePaths();
		if (paths.length === 0) {
			logger.error('No valid Claude data directory found');
			throw new Error('No valid Claude data directory found');
		}

		const options = {
			claudePath: paths[0]!,
			mode,
		};

		const server = createMcpServer(options);
		await startMcpServerStdio(server);
	},
});
