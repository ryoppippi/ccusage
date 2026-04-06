import type { CostMode } from '../_types.ts';
import process from 'node:process';
import { calculateCacheHitRate } from '@ccusage/terminal/table';
import { define } from 'gunshi';
import { Hono } from 'hono/tiny';
import { CostModes } from '../_types.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import {
	loadDailyUsageData,
	loadMonthlyUsageData,
	loadSessionBlockData,
	loadSessionData,
	loadSessionUsageById,
	loadWeeklyUsageData,
} from '../data-loader.ts';
import { logger } from '../logger.ts';

import { dashboardHtml } from './_web_dashboard.ts';

export const webCommand = define({
	name: 'web',
	description: 'Start a web dashboard for interactive usage monitoring',
	args: {
		port: {
			type: 'number',
			short: 'p',
			description: 'Port to listen on',
			default: 10002,
		},
		open: {
			type: 'boolean',
			negatable: true,
			description: 'Auto-open browser (use --no-open to disable)',
			default: true,
		},
		mode: {
			type: 'enum',
			short: 'm',
			description:
				'Cost calculation mode: auto (use costUSD if exists, otherwise calculate), calculate (always calculate), display (always use costUSD)',
			default: 'auto' as const satisfies CostMode,
			choices: CostModes,
		},
		offline: {
			type: 'boolean',
			negatable: true,
			short: 'O',
			description: 'Use cached pricing data for Claude models instead of fetching from API',
			default: false,
		},
	},
	toKebab: true,
	async run(ctx): Promise<void> {
		const port = ctx.values.port ?? 3000;
		const mode = ctx.values.mode;
		const offline = ctx.values.offline;

		const app = new Hono();

		// Dashboard HTML
		app.get('/', (c) => c.html(dashboardHtml));

		// API: daily usage
		app.get('/api/daily', async (c) => {
			const since = c.req.query('since') ?? undefined;
			const until = c.req.query('until') ?? undefined;
			const data = await loadDailyUsageData({ since, until, mode, offline });
			const totals = calculateTotals(data);
			return c.json({
				daily: data.map((d) => ({
					date: d.date,
					inputTokens: d.inputTokens,
					outputTokens: d.outputTokens,
					cacheCreationTokens: d.cacheCreationTokens,
					cacheReadTokens: d.cacheReadTokens,
					cacheHitRate: calculateCacheHitRate(d),
					totalTokens: getTotalTokens(d),
					totalCost: d.totalCost,
					modelsUsed: d.modelsUsed,
					modelBreakdowns: d.modelBreakdowns,
				})),
				totals: createTotalsObject(totals),
			});
		});

		// API: monthly usage
		app.get('/api/monthly', async (c) => {
			const since = c.req.query('since') ?? undefined;
			const until = c.req.query('until') ?? undefined;
			const data = await loadMonthlyUsageData({ since, until, mode, offline });
			const totals = calculateTotals(data);
			return c.json({
				monthly: data.map((d) => ({
					month: d.month,
					inputTokens: d.inputTokens,
					outputTokens: d.outputTokens,
					cacheCreationTokens: d.cacheCreationTokens,
					cacheReadTokens: d.cacheReadTokens,
					cacheHitRate: calculateCacheHitRate(d),
					totalTokens: getTotalTokens(d),
					totalCost: d.totalCost,
					modelsUsed: d.modelsUsed,
					modelBreakdowns: d.modelBreakdowns,
				})),
				totals: createTotalsObject(totals),
			});
		});

		// API: weekly usage
		app.get('/api/weekly', async (c) => {
			const since = c.req.query('since') ?? undefined;
			const until = c.req.query('until') ?? undefined;
			const data = await loadWeeklyUsageData({ since, until, mode, offline });
			const totals = calculateTotals(data);
			return c.json({
				weekly: data.map((d) => ({
					week: d.week,
					inputTokens: d.inputTokens,
					outputTokens: d.outputTokens,
					cacheCreationTokens: d.cacheCreationTokens,
					cacheReadTokens: d.cacheReadTokens,
					cacheHitRate: calculateCacheHitRate(d),
					totalTokens: getTotalTokens(d),
					totalCost: d.totalCost,
					modelsUsed: d.modelsUsed,
					modelBreakdowns: d.modelBreakdowns,
				})),
				totals: createTotalsObject(totals),
			});
		});

		// API: session list
		app.get('/api/session', async (c) => {
			const since = c.req.query('since') ?? undefined;
			const until = c.req.query('until') ?? undefined;
			const data = await loadSessionData({ since, until, mode, offline, order: 'desc' });
			const totals = calculateTotals(data);
			return c.json({
				sessions: data.map((d) => ({
					sessionId: d.sessionId,
					inputTokens: d.inputTokens,
					outputTokens: d.outputTokens,
					cacheCreationTokens: d.cacheCreationTokens,
					cacheReadTokens: d.cacheReadTokens,
					cacheHitRate: calculateCacheHitRate(d),
					totalTokens: getTotalTokens(d),
					totalCost: d.totalCost,
					lastActivity: d.lastActivity,
					modelsUsed: d.modelsUsed,
					modelBreakdowns: d.modelBreakdowns,
					projectPath: d.projectPath,
				})),
				totals: createTotalsObject(totals),
			});
		});

		// API: session detail by ID
		app.get('/api/session/:id', async (c) => {
			const sessionId = c.req.param('id');
			const result = await loadSessionUsageById(sessionId, { mode, offline });
			if (result == null) {
				return c.json({ error: 'Session not found' }, 404);
			}
			const totalTokens = result.entries.reduce((sum, entry) => {
				const u = entry.message.usage;
				return (
					sum +
					u.input_tokens +
					u.output_tokens +
					(u.cache_creation_input_tokens ?? 0) +
					(u.cache_read_input_tokens ?? 0)
				);
			}, 0);
			return c.json({
				sessionId,
				totalCost: result.totalCost,
				totalTokens,
				entries: result.entries.map((entry) => ({
					timestamp: entry.timestamp,
					inputTokens: entry.message.usage.input_tokens,
					outputTokens: entry.message.usage.output_tokens,
					cacheCreationTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
					cacheReadTokens: entry.message.usage.cache_read_input_tokens ?? 0,
					model: entry.message.model ?? 'unknown',
					costUSD: entry.costUSD ?? 0,
				})),
			});
		});

		// API: session blocks
		app.get('/api/blocks', async (c) => {
			const data = await loadSessionBlockData({ mode, offline });
			return c.json({
				blocks: data.map((block) => ({
					id: block.id,
					startTime: block.startTime.toISOString(),
					endTime: block.endTime.toISOString(),
					isActive: block.isActive,
					isGap: block.isGap ?? false,
					entries: block.entries.length,
					tokenCounts: block.tokenCounts,
					totalTokens: getTotalTokens(block.tokenCounts),
					costUSD: block.costUSD,
					models: block.models,
				})),
			});
		});

		// Start server
		const { serve } = await import('@hono/node-server');
		const server = serve({ fetch: app.fetch, port });
		const url = `http://localhost:${port}`;
		logger.info(`Dashboard running at ${url}`);
		logger.info('Press Ctrl+C to stop');

		// Auto-open browser
		if (ctx.values.open) {
			const cmd =
				process.platform === 'darwin'
					? 'open'
					: process.platform === 'win32'
						? 'start'
						: 'xdg-open';
			try {
				const spawn = await import('nano-spawn').then((m) => m.default);
				await spawn(cmd, [url]);
			} catch {
				// Silently ignore if browser cannot be opened
			}
		}

		// Keep process alive, handle shutdown
		await new Promise<void>((resolve) => {
			process.on('SIGINT', () => {
				logger.info('\nShutting down...');
				if (server != null && typeof server.close === 'function') {
					server.close();
				}
				resolve();
			});
		});
	},
});
