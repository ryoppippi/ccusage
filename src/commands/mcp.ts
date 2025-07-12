import { serve } from '@hono/node-server';
import { define } from 'gunshi';
import { MCP_DEFAULT_PORT } from '../_consts.ts';
import { i18n } from '../_i18n.ts';
import { sharedArgs } from '../_shared-args.ts';
import { getClaudePaths } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { createMcpHttpApp, createMcpServer, startMcpServerStdio } from '../mcp.ts';

/**
 * MCP server command that supports both stdio and HTTP transports.
 * Allows starting an MCP server for external integrations with usage reporting tools.
 */
export const mcpCommand = define({
	name: 'mcp',
	get description() { return i18n.t('commands.descriptions.mcp'); },
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
		lang: sharedArgs.lang,
	},
	async run(ctx) {
		// Initialize i18n with CLI language argument
		i18n.initialize(ctx.values.lang);

		const { type, mode, port } = ctx.values;
		// disable info logging for stdio
		if (type === 'stdio') {
			logger.level = 0;
		}

		const paths = getClaudePaths();
		if (paths.length === 0) {
			logger.error(i18n.t('messages.errors.noValidClaudeDir'));
			throw new Error(i18n.t('messages.errors.noValidClaudeDir'));
		}

		const options = {
			claudePath: paths[0]!,
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
