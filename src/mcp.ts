import type { LoadOptions } from './data-loader.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { createFixture } from 'fs-fixture';
import { Hono } from 'hono/tiny';
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

if (import.meta.vitest != null) {
	/* eslint-disable ts/no-unsafe-assignment, ts/no-unsafe-member-access, ts/no-unsafe-call */
	describe('MCP Server', () => {
		describe('createMcpServer', () => {
			it('should create MCP server with default options', () => {
				const server = createMcpServer();
				expect(server).toBeDefined();
			});

			it('should create MCP server with custom options', () => {
				const server = createMcpServer({ claudePath: '/custom/path' });
				expect(server).toBeDefined();
			});
		});

		describe('stdio transport', () => {
			it('should connect via stdio transport and list tools', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const client = new Client({ name: 'test-client', version: '1.0.0' });
				const server = createMcpServer({ claudePath: fixture.path });

				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

				await Promise.all([
					client.connect(clientTransport),
					server.connect(serverTransport),
				]);

				const result = await client.listTools();
				expect(result.tools).toHaveLength(4);

				const toolNames = result.tools.map(tool => tool.name);
				expect(toolNames).toContain('daily');
				expect(toolNames).toContain('session');
				expect(toolNames).toContain('monthly');
				expect(toolNames).toContain('blocks');

				await client.close();
				await server.close();
			});

			it('should call daily tool successfully', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const client = new Client({ name: 'test-client', version: '1.0.0' });
				const server = createMcpServer({ claudePath: fixture.path });

				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

				await Promise.all([
					client.connect(clientTransport),
					server.connect(serverTransport),
				]);

				const result = await client.callTool({
					name: 'daily',
					arguments: { mode: 'auto' },
				});

				expect(result).toHaveProperty('content');
				expect(Array.isArray(result.content)).toBe(true);
				expect(result.content).toHaveLength(1);

				expect((result.content as any).at(0)).toHaveProperty('type', 'text');

				expect((result.content as any).at(0)).toHaveProperty('text');

				const data = JSON.parse((result.content as any).at(0).text as string);
				expect(Array.isArray(data)).toBe(true);

				await client.close();
				await server.close();
			});

			it('should call session tool successfully', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const client = new Client({ name: 'test-client', version: '1.0.0' });
				const server = createMcpServer({ claudePath: fixture.path });

				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

				await Promise.all([
					client.connect(clientTransport),
					server.connect(serverTransport),
				]);

				const result = await client.callTool({
					name: 'session',
					arguments: { mode: 'auto' },
				});

				expect(result).toHaveProperty('content');
				expect(result.content).toHaveLength(1);
				expect((result.content as any)[0]).toHaveProperty('type', 'text');
				expect((result.content as any)[0]).toHaveProperty('text');

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(Array.isArray(data)).toBe(true);

				await client.close();
				await server.close();
			});

			it('should call monthly tool successfully', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const client = new Client({ name: 'test-client', version: '1.0.0' });
				const server = createMcpServer({ claudePath: fixture.path });

				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

				await Promise.all([
					client.connect(clientTransport),
					server.connect(serverTransport),
				]);

				const result = await client.callTool({
					name: 'monthly',
					arguments: { mode: 'auto' },
				});

				expect(result).toHaveProperty('content');
				expect(result.content).toHaveLength(1);
				expect((result.content as any)[0]).toHaveProperty('type', 'text');
				expect((result.content as any)[0]).toHaveProperty('text');

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(Array.isArray(data)).toBe(true);

				await client.close();
				await server.close();
			});

			it('should call blocks tool successfully', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const client = new Client({ name: 'test-client', version: '1.0.0' });
				const server = createMcpServer({ claudePath: fixture.path });

				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

				await Promise.all([
					client.connect(clientTransport),
					server.connect(serverTransport),
				]);

				const result = await client.callTool({
					name: 'blocks',
					arguments: { mode: 'auto' },
				});

				expect(result).toHaveProperty('content');
				expect(result.content).toHaveLength(1);
				expect((result.content as any)[0]).toHaveProperty('type', 'text');
				expect((result.content as any)[0]).toHaveProperty('text');

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(Array.isArray(data)).toBe(true);

				await client.close();
				await server.close();
			});
		});

		describe('HTTP transport', () => {
			it('should create HTTP app', () => {
				const app = createMcpHttpApp();
				expect(app).toBeDefined();
			});

			it('should handle valid POST requests without 405 error', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const app = createMcpHttpApp({ claudePath: fixture.path });

				// Test with a valid JSON POST request
				const mcpRequest = {
					jsonrpc: '2.0',
					method: 'test',
					id: 1,
				};

				const response = await app.request('/', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(mcpRequest),
				});

				// Should not return method not allowed for POST requests
				expect(response.status).not.toBe(405);
			});

			it('should return 405 for GET requests', async () => {
				const app = createMcpHttpApp();

				const response = await app.request('/', { method: 'GET' });

				expect(response.status).toBe(405);
				const data = await response.json();
				expect(data).toMatchObject({
					jsonrpc: '2.0',
					error: {
						code: -32000,
						message: 'Method not allowed.',
					},
					id: null,
				});
			});

			it('should return 405 for DELETE requests', async () => {
				const app = createMcpHttpApp();

				const response = await app.request('/', { method: 'DELETE' });

				expect(response.status).toBe(405);
				const data = await response.json();
				expect(data).toMatchObject({
					jsonrpc: '2.0',
					error: {
						code: -32000,
						message: 'Method not allowed.',
					},
					id: null,
				});
			});

			it('should handle invalid JSON in POST request', async () => {
				const app = createMcpHttpApp();

				const response = await app.request('/', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: 'invalid json',
				});

				expect(response.status).toBe(500);
				const data = await response.json();
				expect(data).toMatchObject({
					jsonrpc: '2.0',
					error: {
						code: -32603,
						message: 'Internal server error',
					},
					id: null,
				});
			});
		});
	});
}
