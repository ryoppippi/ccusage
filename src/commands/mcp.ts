import { define } from 'gunshi';
import { getDefaultClaudePath } from '../data-loader.ts';
import { logger } from '../logger.ts';
import { createMcpServer } from '../mcp.ts';
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
		// disable info logging
		if (type === 'stdio') {
			logger.level = 0;
		}

		const server = createMcpServer({
			claudePath: getDefaultClaudePath(),
			mode,
		});

		await server.start(
			ctx.values.type === 'http'
				? { transportType: 'httpStream', httpStream: { port } }
				: { transportType: 'stdio' },
		);
	},
});
