import { serve } from '@hono/node-server';
import { define } from 'gunshi';
import { getDefaultClaudePath } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { createMcpHttpApp, createMcpServer, startMcpServerStdio } from '../mcp.ts';
import { sharedArgs } from '../shared-args.internal.ts';

export const mcpCommand = define({
	name: 'mcp',
	description: 'Show usage report for MCP',
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
			description: 'Port for HTTP transport (default: 8080)',
			default: 8080,
		},
	},
	async run(ctx) {
		const { type, mode, port } = ctx.values;
		// disable info logging for stdio
		if (type === 'stdio') {
			logger.level = 0;
		}

		const options = {
			claudePath: getDefaultClaudePath(),
			mode,
		};

		if (type === 'stdio') {
			const server = createMcpServer(options);
			await startMcpServerStdio(server);
		}
		else {
			const app = createMcpHttpApp(options);
			// Use the Hono app to handle requests
			serve({
				fetch: app.fetch,
				port,
			});
			logger.info(`MCP server is running on http://localhost:${port}`);
		}
	},
});
