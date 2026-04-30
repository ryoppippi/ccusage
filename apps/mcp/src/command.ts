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

		let claudePath = '';
		try {
			const paths = getClaudePaths();
			claudePath = paths.at(0) ?? '';
		} catch {
			claudePath = '';
		}
		if (claudePath === '') {
			logger.warn(
				'No valid Claude data directory found; Claude usage tools may return empty results.',
			);
		}

		const options: CommandOptions = {
			claudePath,
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

function shouldSuppressHeader(args: string[]): boolean {
	const isHelpOrVersion = args.some(
		(arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v',
	);
	if (isHelpOrVersion) {
		return false;
	}

	const typeIndex = args.findIndex((arg) => arg === '--type' || arg === '-t');
	if (typeIndex >= 0) {
		return args[typeIndex + 1] === 'stdio';
	}

	const inlineType = args.find((arg) => arg.startsWith('--type=') || arg.startsWith('-t='));
	if (inlineType != null) {
		const [, value = ''] = inlineType.split('=', 2);
		return value === 'stdio';
	}

	return true;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
	// When invoked through npx/bunx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = argv;
	if (args[0] === 'ccusage-mcp') {
		args = args.slice(1);
	}

	const suppressHeader = shouldSuppressHeader(args);

	await cli(args, mcpCommand, {
		name,
		version,
		description,
		renderHeader: suppressHeader ? null : undefined,
		subCommands: new Map(),
	});
}

if (import.meta.vitest != null) {
	describe('shouldSuppressHeader', () => {
		it('suppresses the header when no transport type is provided', () => {
			expect(shouldSuppressHeader([])).toBe(true);
		});

		it('suppresses the header for explicit stdio transport flags', () => {
			expect(shouldSuppressHeader(['--type', 'stdio'])).toBe(true);
			expect(shouldSuppressHeader(['-t', 'stdio'])).toBe(true);
			expect(shouldSuppressHeader(['--type=stdio'])).toBe(true);
			expect(shouldSuppressHeader(['-t=stdio'])).toBe(true);
		});

		it('does not suppress the header for non-stdio transport or help/version flags', () => {
			expect(shouldSuppressHeader(['--type', 'http'])).toBe(false);
			expect(shouldSuppressHeader(['--type=http'])).toBe(false);
			expect(shouldSuppressHeader(['--help'])).toBe(false);
			expect(shouldSuppressHeader(['-v'])).toBe(false);
		});
	});
}
