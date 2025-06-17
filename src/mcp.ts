import type { LoadOptions } from './data-loader.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { Hono } from 'hono';
import { z } from 'zod';

import { name, version } from '../package.json';
import {
	getDefaultClaudePath,
	loadDailyUsageData,
	loadMonthlyUsageData,
	loadSessionBlockData,
	loadSessionData,
} from './data-loader.ts';
import { logger } from './logger.ts';
import { dateSchema } from './types.internal.ts';

/** Default options for the MCP server */
const defaultOptions = {
	claudePath: getDefaultClaudePath(),
} as const satisfies LoadOptions;

/**
 * Creates an MCP server with tools for showing usage reports.
 * Registers tools for daily, session, monthly, and blocks usage data.
 *
 * @param options - Configuration options for the MCP server
 * @param options.claudePath - Path to Claude's data directory
 * @returns Configured MCP server instance with registered tools
 */
export function createMcpServer({
	claudePath,
}: LoadOptions = defaultOptions): McpServer {
	const server = new McpServer({
		name,
		version,
	});

	// Define the schema for tool parameters
	const parametersZodSchema = {
		since: dateSchema.optional(),
		until: dateSchema.optional(),
		mode: z.enum(['auto', 'calculate', 'display']).default('auto').optional(),
	};

	// Register daily tool
	server.registerTool(
		'daily',
		{
			description: 'Show usage report grouped by date',
			inputSchema: parametersZodSchema,
		},
		async (args) => {
			const dailyData = await loadDailyUsageData({ ...args, claudePath });
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(dailyData, null, 2),
					},
				],
			};
		},
	);

	// Register session tool
	server.registerTool(
		'session',
		{
			description: 'Show usage report grouped by conversation session',
			inputSchema: parametersZodSchema,
		},
		async (args) => {
			const sessionData = await loadSessionData({ ...args, claudePath });
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(sessionData, null, 2),
					},
				],
			};
		},
	);

	// Register monthly tool
	server.registerTool(
		'monthly',
		{
			description: 'Show usage report grouped by month',
			inputSchema: parametersZodSchema,
		},
		async (args) => {
			const monthlyData = await loadMonthlyUsageData({ ...args, claudePath });
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(monthlyData, null, 2),
					},
				],
			};
		},
	);

	// Register blocks tool
	server.registerTool(
		'blocks',
		{
			description: 'Show usage report grouped by session billing blocks',
			inputSchema: parametersZodSchema,
		},
		async (args) => {
			const blocksData = await loadSessionBlockData({ ...args, claudePath });
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(blocksData, null, 2),
					},
				],
			};
		},
	);

	return server;
}

/**
 * Start the MCP server with stdio transport.
 * Used for traditional MCP client connections via standard input/output.
 *
 * @param server - The MCP server instance to start
 */
export async function startMcpServerStdio(
	server: McpServer,
): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

/**
 * Create Hono app for MCP HTTP server.
 * Provides HTTP transport support for MCP protocol using Hono framework.
 * Handles POST requests for MCP communication and returns appropriate errors for other methods.
 *
 * @param options - Configuration options for the MCP server
 * @param options.claudePath - Path to Claude's data directory
 * @returns Configured Hono application for HTTP MCP transport
 */
export function createMcpHttpApp(options: LoadOptions = defaultOptions): Hono {
	const app = new Hono();

	app.post('/', async (c) => {
		const { req, res } = toReqRes(c.req.raw);
		const mcpServer = createMcpServer(options);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // Stateless mode
		});

		await mcpServer.connect(transport);
		await transport.handleRequest(req, res, await c.req.json() as unknown);

		res.on('close', () => {
			transport.close().catch(() => {});
			mcpServer.close().catch(() => {});
		});

		return toFetchResponse(res);
	});

	app.on(['GET', 'DELETE'], '/', (c) => {
		return c.json(
			{
				jsonrpc: '2.0',
				error: {
					code: -32000,
					message: 'Method not allowed.',
				},
				id: null,
			},
			405,
		);
	});

	app.onError((e, c) => {
		logger.error(e.message);
		return c.json(
			{
				jsonrpc: '2.0',
				error: {
					code: -32603,
					message: 'Internal server error',
				},
				id: null,
			},
			500,
		);
	});

	return app;
}
