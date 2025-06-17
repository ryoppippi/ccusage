import type { LoadOptions } from './data-loader.ts';
import type { CostMode } from './types.internal.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { name, version } from '../package.json';
import {
	getDefaultClaudePath,
	loadDailyUsageData,
	loadMonthlyUsageData,
	loadSessionBlockData,
	loadSessionData,
} from './data-loader.ts';
import { dateSchema } from './types.internal.ts';

/** Default options for the MCP server */
const defaultOptions = {
	claudePath: getDefaultClaudePath(),
} as const satisfies LoadOptions;

/**
 * Creates an MCP server with tools for showing usage reports.
 */
export function createMcpServer({
	claudePath,
}: LoadOptions = defaultOptions): McpServer {
	const server = new McpServer({
		name,
		version,
	});

	const validateArgs = (args: unknown): { since?: string; until?: string; mode: CostMode } => {
		const schema = z.object({
			since: dateSchema.optional(),
			until: dateSchema.optional(),
			mode: z.enum(['auto', 'calculate', 'display']).default('auto').optional(),
		});
		const parsed = schema.parse(args);

		// Ensure mode is always defined as CostMode
		let mode: CostMode = 'auto';
		if (parsed.mode === 'calculate') {
			mode = 'calculate';
		}
		else if (parsed.mode === 'display') {
			mode = 'display';
		}

		const result: { since?: string; until?: string; mode: CostMode } = {
			mode,
		};

		const since = parsed.since;
		if (since !== undefined) {
			result.since = since;
		}

		const until = parsed.until;
		if (until !== undefined) {
			result.until = until;
		}

		return result;
	};

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
			const validatedArgs = validateArgs(args);
			const dailyData = await loadDailyUsageData({ ...validatedArgs, claudePath });
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
			const validatedArgs = validateArgs(args);
			const sessionData = await loadSessionData({ ...validatedArgs, claudePath });
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
			const validatedArgs = validateArgs(args);
			const monthlyData = await loadMonthlyUsageData({ ...validatedArgs, claudePath });
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
			const validatedArgs = validateArgs(args);
			const blocksData = await loadSessionBlockData({ ...validatedArgs, claudePath });
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
