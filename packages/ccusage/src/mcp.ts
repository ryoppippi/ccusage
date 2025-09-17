/**
 * @fileoverview MCP (Model Context Protocol) server implementation
 *
 * This module provides MCP server functionality for exposing ccusage data
 * through the Model Context Protocol. It includes both stdio and HTTP transport
 * options for integration with various MCP clients.
 *
 * @module mcp
 */

import type { LoadOptions } from './data-loader.ts';
import { StreamableHTTPTransport } from '@hono/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFixture } from 'fs-fixture';
import { Hono } from 'hono/tiny';
import { z } from 'zod';

import { name, version } from '../package.json';
import { DEFAULT_LOCALE } from './_consts.ts';
import { filterDateSchema } from './_types.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from './calculate-cost.ts';
import {
	getClaudePaths,
	loadDailyUsageData,
	loadMonthlyUsageData,
	loadSessionBlockData,
	loadSessionData,
} from './data-loader.ts';

// Output schemas for structured responses
const modelBreakdownSchema = z.object({
	modelName: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	cost: z.number(),
});

const dailyUsageSchema = z.object({
	date: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	totalTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(z.string()),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

const sessionUsageSchema = z.object({
	sessionId: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	totalTokens: z.number(),
	totalCost: z.number(),
	lastActivity: z.string(),
	modelsUsed: z.array(z.string()),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

const monthlyUsageSchema = z.object({
	month: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheCreationTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	totalTokens: z.number(),
	totalCost: z.number(),
	modelsUsed: z.array(z.string()),
	modelBreakdowns: z.array(modelBreakdownSchema),
});

const blockUsageSchema = z.object({
	id: z.string(),
	startTime: z.string(),
	endTime: z.string().optional(),
	actualEndTime: z.string().optional(),
	isActive: z.boolean(),
	isGap: z.boolean(),
	entries: z.number(),
	tokenCounts: z.object({
		inputTokens: z.number(),
		outputTokens: z.number(),
		cacheCreationInputTokens: z.number(),
		cacheReadInputTokens: z.number(),
	}),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.array(z.string()),
	burnRate: z.number().nullable(),
	projection: z.unknown().nullable(),
});

// Tool response schemas matching actual data format
const dailyResponseSchema = {
	daily: z.array(dailyUsageSchema),
	totals: z.object({
		totalInputTokens: z.number().optional(),
		totalOutputTokens: z.number().optional(),
		totalCacheCreationTokens: z.number().optional(),
		totalCacheReadTokens: z.number().optional(),
		totalTokens: z.number().optional(),
		totalCost: z.number().optional(),
		modelsUsed: z.array(z.string()).optional(),
	}),
};

const sessionResponseSchema = {
	sessions: z.array(sessionUsageSchema),
	totals: z.object({
		totalInputTokens: z.number().optional(),
		totalOutputTokens: z.number().optional(),
		totalCacheCreationTokens: z.number().optional(),
		totalCacheReadTokens: z.number().optional(),
		totalTokens: z.number().optional(),
		totalCost: z.number().optional(),
		modelsUsed: z.array(z.string()).optional(),
	}),
};

const monthlyResponseSchema = {
	monthly: z.array(monthlyUsageSchema),
	totals: z.object({
		totalInputTokens: z.number().optional(),
		totalOutputTokens: z.number().optional(),
		totalCacheCreationTokens: z.number().optional(),
		totalCacheReadTokens: z.number().optional(),
		totalTokens: z.number().optional(),
		totalCost: z.number().optional(),
		modelsUsed: z.array(z.string()).optional(),
	}),
};

const blocksResponseSchema = {
	blocks: z.array(blockUsageSchema),
};

// Type for structured content to avoid repetitive casting
type StructuredContent = { [x: string]: unknown };

/**
 * Helper function to transform usage data with totals into JSON output format
 */
function transformUsageDataWithTotals<T>(
	data: T[],
	totals: ReturnType<typeof calculateTotals>,
	mapper: (item: T) => any,
	key: string,
): { [K in string]: any } & { totals: ReturnType<typeof createTotalsObject> } {
	return {
		[key]: data.map(mapper),
		totals: createTotalsObject(totals),
	};
}

/** Default options for the MCP server */
function defaultOptions(): LoadOptions {
	const paths = getClaudePaths();
	if (paths.length === 0) {
		throw new Error('No valid Claude path found. Ensure getClaudePaths() returns at least one valid path.');
	}
	return { claudePath: paths[0] } as const satisfies LoadOptions;
}

/**
 * Creates an MCP server with tools for showing usage reports.
 * Registers tools for daily, session, monthly, and blocks usage data.
 *
 * @param options - Configuration options for the MCP server
 * @param options.claudePath - Path to Claude's data directory
 * @returns Configured MCP server instance with registered tools
 */
export function createMcpServer(options?: LoadOptions): McpServer {
	const server = new McpServer({
		name,
		version,
	});

	// Define the schema for tool parameters
	const parametersZodSchema = {
		since: filterDateSchema.optional(),
		until: filterDateSchema.optional(),
		mode: z.enum(['auto', 'calculate', 'display']).default('auto').optional(),
		timezone: z.string().optional(),
		locale: z.string().default(DEFAULT_LOCALE).optional(),
	};

	const { claudePath } = options ?? defaultOptions();

	// Register daily tool
	server.registerTool(
		'daily',
		{
			description: 'Show usage report grouped by date',
			inputSchema: parametersZodSchema,
			outputSchema: dailyResponseSchema,
		},
		async (args) => {
			const dailyData = await loadDailyUsageData({ ...args, claudePath });

			// Transform data to match CLI JSON output format
			const totals = calculateTotals(dailyData);
			const jsonOutput = transformUsageDataWithTotals(
				dailyData,
				totals,
				data => ({
					date: data.date,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				}),
				'daily',
			);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(jsonOutput, null, 2),
					},
				],
				structuredContent: jsonOutput as StructuredContent,
			};
		},
	);

	// Register session tool
	server.registerTool(
		'session',
		{
			description: 'Show usage report grouped by conversation session',
			inputSchema: parametersZodSchema,
			outputSchema: sessionResponseSchema,
		},
		async (args) => {
			const sessionData = await loadSessionData({ ...args, claudePath });

			// Transform data to match CLI JSON output format
			const totals = calculateTotals(sessionData);
			const jsonOutput = transformUsageDataWithTotals(
				sessionData,
				totals,
				data => ({
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				}),
				'sessions',
			);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(jsonOutput, null, 2),
					},
				],
				structuredContent: jsonOutput as StructuredContent,
			};
		},
	);

	// Register monthly tool
	server.registerTool(
		'monthly',
		{
			description: 'Show usage report grouped by month',
			inputSchema: parametersZodSchema,
			outputSchema: monthlyResponseSchema,
		},
		async (args) => {
			const monthlyData = await loadMonthlyUsageData({ ...args, claudePath });

			// Transform data to match CLI JSON output format
			const totals = calculateTotals(monthlyData);
			const jsonOutput = transformUsageDataWithTotals(
				monthlyData,
				totals,
				data => ({
					month: data.month,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				}),
				'monthly',
			);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(jsonOutput, null, 2),
					},
				],
				structuredContent: jsonOutput as StructuredContent,
			};
		},
	);

	// Register blocks tool
	server.registerTool(
		'blocks',
		{
			description: 'Show usage report grouped by session billing blocks',
			inputSchema: parametersZodSchema,
			outputSchema: blocksResponseSchema,
		},
		async (args) => {
			const blocks = await loadSessionBlockData({ ...args, claudePath });

			// Transform data to match CLI JSON output format
			const jsonOutput = {
				blocks: blocks.map((block) => {
					return {
						id: block.id,
						startTime: block.startTime.toISOString(),
						endTime: block.endTime.toISOString(),
						actualEndTime: block.actualEndTime?.toISOString() ?? null,
						isActive: block.isActive,
						isGap: block.isGap ?? false,
						entries: block.entries.length,
						tokenCounts: block.tokenCounts,
						totalTokens:
							block.tokenCounts.inputTokens
							+ block.tokenCounts.outputTokens,
						costUSD: block.costUSD,
						models: block.models,
						burnRate: null,
						projection: null,
					};
				}),
			};

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(jsonOutput, null, 2),
					},
				],
				structuredContent: jsonOutput as StructuredContent,
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
export function createMcpHttpApp(options?: LoadOptions): Hono {
	const app = new Hono();

	const mcpServer = createMcpServer(options ?? defaultOptions());

	app.all('/', async (c) => {
		const transport = new StreamableHTTPTransport();
		await mcpServer.connect(transport);
		return transport.handleRequest(c);
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

				// Test structured content
				expect(result).toHaveProperty('structuredContent');
				expect((result as any).structuredContent).toHaveProperty('daily');
				expect(Array.isArray((result as any).structuredContent.daily)).toBe(true);

				const data = JSON.parse((result.content as any).at(0).text as string);
				expect(data).toHaveProperty('daily');
				expect(data).toHaveProperty('totals');
				expect(Array.isArray(data.daily)).toBe(true);

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

				// Test structured content
				expect(result).toHaveProperty('structuredContent');
				expect((result as any).structuredContent).toHaveProperty('sessions');
				expect((result as any).structuredContent).toHaveProperty('totals');
				expect(Array.isArray((result as any).structuredContent.sessions)).toBe(true);

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(data).toHaveProperty('sessions');
				expect(data).toHaveProperty('totals');
				expect(Array.isArray(data.sessions)).toBe(true);

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
				expect(data).toHaveProperty('monthly');
				expect(data).toHaveProperty('totals');
				expect(Array.isArray(data.monthly)).toBe(true);

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
				expect(data).toHaveProperty('blocks');
				expect(Array.isArray(data.blocks)).toBe(true);

				await client.close();
				await server.close();
			});
		});

		describe('HTTP transport', () => {
			it('should create HTTP app', () => {
				const app = createMcpHttpApp();
				expect(app).toBeDefined();
			});

			it('should handle invalid JSON in POST request', async () => {
				const app = createMcpHttpApp();

				const response = await app.request('/', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: 'invalid json',
				});

				expect(response.status).toBe(406);
				const data = await response.json();
				expect(data).toMatchObject({
					jsonrpc: '2.0',
					error: {
						code: -32000,
						message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
					},
					id: null,
				});
			});

			it('should handle MCP initialize request', async () => {
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

				const response = await app.request('/', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Accept': 'application/json, text/event-stream',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						method: 'initialize',
						params: {
							protocolVersion: '1.0.0',
							capabilities: {},
							clientInfo: { name: 'test-client', version: '1.0.0' },
						},
						id: 1,
					}),
				});

				expect(response.status).toBe(200);
				expect(response.headers.get('content-type')).toBe('text/event-stream');

				const text = await response.text();
				expect(text).toContain('event: message');
				expect(text).toContain('data: ');

				// Extract the JSON data from the SSE response
				const dataLine = text.split('\n').find(line => line.startsWith('data: '));
				expect(dataLine).toBeDefined();
				const data = JSON.parse(dataLine!.replace('data: ', ''));

				expect(data.jsonrpc).toBe('2.0');
				expect(data.id).toBe(1);
				expect(data.result).toHaveProperty('protocolVersion');
				expect(data.result).toHaveProperty('capabilities');
				expect(data.result.serverInfo).toEqual({ name, version });
			});

			it('should handle MCP callTool request for daily tool', async () => {
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

				// First initialize
				await app.request('/', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Accept': 'application/json, text/event-stream',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						method: 'initialize',
						params: {
							protocolVersion: '1.0.0',
							capabilities: {},
							clientInfo: { name: 'test-client', version: '1.0.0' },
						},
						id: 1,
					}),
				});

				// Then call tool
				const response = await app.request('/', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Accept': 'application/json, text/event-stream',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						method: 'tools/call',
						params: {
							name: 'daily',
							arguments: { mode: 'auto' },
						},
						id: 2,
					}),
				});

				expect(response.status).toBe(200);
				const text = await response.text();

				expect(text).toContain('event: message');
				expect(text).toContain('data: ');

				// Extract the JSON data from the SSE response
				const dataLine = text.split('\n').find(line => line.startsWith('data: '));
				expect(dataLine).toBeDefined();
				const data = JSON.parse(dataLine!.replace('data: ', ''));

				expect(data.jsonrpc).toBe('2.0');
				expect(data.id).toBe(2);
				expect(data.result).toHaveProperty('content');
				expect(Array.isArray(data.result.content)).toBe(true);
			});
		});

		describe('error handling', () => {
			it('should handle tool call with invalid arguments', async () => {
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

				// Test with invalid mode enum value
				await expect(client.callTool({
					name: 'daily',
					arguments: { mode: 'invalid_mode' },
				})).rejects.toThrow('Invalid enum value');

				await client.close();
				await server.close();
			});

			it('should handle tool call with invalid date format', async () => {
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

				// Test with invalid date format
				await expect(client.callTool({
					name: 'daily',
					arguments: { since: 'not-a-date', until: '2024-invalid' },
				})).rejects.toThrow('Date must be in YYYYMMDD format');

				await client.close();
				await server.close();
			});

			it('should handle tool call with unknown tool name', async () => {
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

				// Test with unknown tool name
				await expect(client.callTool({
					name: 'unknown-tool',
					arguments: {},
				})).rejects.toThrow('Tool unknown-tool not found');

				await client.close();
				await server.close();
			});
		});

		describe('edge cases', () => {
			it('should handle empty data directory', async () => {
				await using fixture = await createFixture({
					'projects/.keep': '',
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
				expect((result.content as any)[0]).toHaveProperty('type', 'text');

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(data).toHaveProperty('daily');
				expect(data).toHaveProperty('totals');
				expect(Array.isArray(data.daily)).toBe(true);
				expect(data.daily).toHaveLength(0);

				await client.close();
				await server.close();
			});

			it('should handle malformed JSONL files', async () => {
				await using fixture = await createFixture({
					'projects/test-project/session1/usage.jsonl': 'invalid json\n{"valid": "json"}',
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

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(data).toHaveProperty('daily');
				expect(data).toHaveProperty('totals');
				expect(Array.isArray(data.daily)).toBe(true);
				// Should still return data, as malformed lines are silently skipped
				expect(data.daily).toHaveLength(0);

				await client.close();
				await server.close();
			});

			it('should handle missing Claude directory', async () => {
				const client = new Client({ name: 'test-client', version: '1.0.0' });
				const server = createMcpServer({ claudePath: '/nonexistent/path' });

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

				const data = JSON.parse((result.content as any)[0].text as string);
				expect(data).toHaveProperty('daily');
				expect(data).toHaveProperty('totals');
				expect(Array.isArray(data.daily)).toBe(true);
				expect(data.daily).toHaveLength(0);

				await client.close();
				await server.close();
			});

			it('should handle concurrent tool calls', async () => {
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

				// Call multiple tools concurrently
				const [dailyResult, sessionResult, monthlyResult, blocksResult] = await Promise.all([
					client.callTool({ name: 'daily', arguments: { mode: 'auto' } }),
					client.callTool({ name: 'session', arguments: { mode: 'auto' } }),
					client.callTool({ name: 'monthly', arguments: { mode: 'auto' } }),
					client.callTool({ name: 'blocks', arguments: { mode: 'auto' } }),
				]);

				expect(dailyResult).toHaveProperty('content');
				expect(sessionResult).toHaveProperty('content');
				expect(monthlyResult).toHaveProperty('content');
				expect(blocksResult).toHaveProperty('content');

				// Verify all responses are valid JSON objects with expected structure
				const dailyData = JSON.parse((dailyResult.content as any)[0].text as string);
				const sessionData = JSON.parse((sessionResult.content as any)[0].text as string);
				const monthlyData = JSON.parse((monthlyResult.content as any)[0].text as string);
				const blocksData = JSON.parse((blocksResult.content as any)[0].text as string);

				expect(dailyData).toHaveProperty('daily');
				expect(Array.isArray(dailyData.daily)).toBe(true);
				expect(sessionData).toHaveProperty('sessions');
				expect(Array.isArray(sessionData.sessions)).toBe(true);
				expect(monthlyData).toHaveProperty('monthly');
				expect(Array.isArray(monthlyData.monthly)).toBe(true);
				expect(blocksData).toHaveProperty('blocks');
				expect(Array.isArray(blocksData.blocks)).toBe(true);

				await client.close();
				await server.close();
			});
		});
	});
}
