import type { LoadOptions } from 'ccusage/data-loader';
import process from 'node:process';
import { serve } from '@hono/node-server';
import { getClaudePaths } from 'ccusage/data-loader';
import { logger } from 'ccusage/logger';
import { cli, define } from 'gunshi';
import { description, name, version } from '../package.json';
import { createMcpHttpApp, createMcpServer, startMcpServerStdio } from './mcp.ts';

type McpType = (typeof MCP_TYPE_CHOICES)[number];
type Mode = LoadOptions['mode'];

const MCP_DEFAULT_PORT = 8080;
const MODE_CHOICES = ['auto', 'calculate', 'display'] as const satisfies readonly Mode[];
const MCP_TYPE_CHOICES = ['stdio', 'http'] as const satisfies readonly string[];

type CommandOptions = LoadOptions & {
	port?: number;
	type?: McpType;
};

export const mcpCommand = define({
	name: 'mcp',
	description: 'Start MCP server with usage reporting tools',
	args: {
		mode: {
			type: 'enum',
			short: 'm',
			description: 'Cost calculation mode for usage reports',
			choices: MODE_CHOICES,
			default: 'auto' satisfies Mode,
		},
		type: {
			type: 'enum',
			short: 't',
			description: 'Transport type for MCP server',
			choices: MCP_TYPE_CHOICES,
			default: 'stdio' satisfies McpType,
		},
		port: {
			type: 'number',
			short: 'p',
			description: `Port for HTTP transport (default: ${MCP_DEFAULT_PORT})`,
			default: MCP_DEFAULT_PORT,
		},
	},
	async run(ctx) {
		const { type: mcpType, mode, port } = ctx.values;

		if (mcpType === 'stdio') {
			logger.level = 0;
		}

		const paths = getClaudePaths();
		if (paths.length === 0) {
			logger.error('No valid Claude data directory found');
			throw new Error('No valid Claude data directory found');
		}

		const options: CommandOptions = {
			claudePath: paths.at(0),
			mode,
		};

		switch (mcpType) {
			case 'stdio': {
				const server = createMcpServer(options);
				await startMcpServerStdio(server);
				return;
			}
			case 'http': {
				const app = createMcpHttpApp(options);
				serve({
					fetch: app.fetch,
					port,
				});
				logger.info(`MCP server is running on http://localhost:${port}`);
				return;
			}
			default: {
				mcpType satisfies never;
				throw new Error(`Unsupported MCP type: ${mcpType as string}`);
			}
		}
	},
});

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
	// When invoked through npx/bunx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = argv;
	if (args[0] === 'ccusage-mcp') {
		args = args.slice(1);
	}

	await cli(args, mcpCommand, {
		name,
		version,
		description,
		subCommands: new Map(),
	});
}
