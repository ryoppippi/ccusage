import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { define } from 'gunshi';
import { MCP_DEFAULT_PORT } from '../_consts.ts';
import { sharedArgs } from '../_shared-args.ts';
import { getClaudePaths } from '../data-loader.ts';
import { logger } from '../logger.ts';

type McpModule = typeof import('@ccusage/mcp');

let cachedMcpModule: McpModule | null = null;

function getMcpModule(): McpModule {
	if (cachedMcpModule != null) {
		return cachedMcpModule;
	}
	const require = createRequire(import.meta.url);
	cachedMcpModule = require('@ccusage/mcp') as McpModule;
	return cachedMcpModule;
}

/**
 * MCP server command that supports both stdio and HTTP transports.
 * Allows starting an MCP server for external integrations with usage reporting tools.
 */
export const mcpCommand = define({
	name: 'mcp',
	description: 'Start MCP server with usage reporting tools',
	args: {
		mode: sharedArgs.mode,
		type: {
			type: 'enum',
			short: 't',
			description: 'Transport type for MCP server',
			choices: ['stdio', 'http'] as const,
			default: 'stdio',
		},
		port: {
			type: 'number',
			description: `Port for HTTP transport (default: ${MCP_DEFAULT_PORT})`,
			default: MCP_DEFAULT_PORT,
		},
	},
	async run(ctx) {
		const { type, mode, port } = ctx.values;
		// disable info logging for stdio
		if (type === 'stdio') {
			logger.level = 0;
		}

		const paths = getClaudePaths();
		if (paths.length === 0) {
			logger.error('No valid Claude data directory found');
			throw new Error('No valid Claude data directory found');
		}

		const options = {
			claudePath: paths[0]!,
			mode,
		};

		const mcp = getMcpModule();

		if (type === 'stdio') {
			const server = mcp.createMcpServer(options);
			await mcp.startMcpServerStdio(server);
		}
		else {
			const app = mcp.createMcpHttpApp(options);
			// Use the Hono app to handle requests
			serve({
				fetch: app.fetch,
				port,
			});
			logger.info(`MCP server is running on http://localhost:${port}`);
		}
	},
});
