import process from 'node:process';
import Table from 'cli-table3';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadSessionWindowData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import { formatCurrency, formatNumber } from '../utils.internal.ts';

export const sessionsCommand = define({
	name: 'sessions',
	description: 'Show usage report grouped by 5-hour session windows (Claude Max plan)',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const sessionData = await loadSessionWindowData({
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
			mode: ctx.values.mode,
			order: ctx.values.order,
		});

		if (sessionData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map(monthStats => ({
					month: monthStats.month,
					totalSessions: monthStats.totalSessions,
					remainingSessions: monthStats.remainingSessions,
					utilizationPercent: monthStats.utilizationPercent,
					totalCost: monthStats.totalCost,
					totalTokens: monthStats.totalTokens,
					averageCostPerSession: monthStats.averageCostPerSession,
					averageTokensPerSession: monthStats.averageTokensPerSession,
					currentSession: monthStats.currentSession,
					windows: monthStats.windows.map(window => ({
						windowId: window.windowId,
						startTime: window.startTime,
						endTime: window.endTime,
						inputTokens: window.inputTokens,
						outputTokens: window.outputTokens,
						cacheCreationTokens: window.cacheCreationTokens,
						cacheReadTokens: window.cacheReadTokens,
						totalTokens: window.inputTokens + window.outputTokens + window.cacheCreationTokens + window.cacheReadTokens,
						totalCost: window.totalCost,
						messageCount: window.messageCount,
						conversationCount: window.conversationCount,
					})),
				})),
			};
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Session Usage Report (5-Hour Windows)');

			for (const monthStats of sessionData) {
				// Month header with utilization stats
				const utilizationColor = monthStats.utilizationPercent > 80
					? 'red'
					: monthStats.utilizationPercent > 60
						? 'yellow'
						: 'green';

				logger.info(`\n${pc.bold(monthStats.month)} - ${pc[utilizationColor](`${monthStats.totalSessions} sessions used`)} (${pc[utilizationColor](`${monthStats.utilizationPercent.toFixed(1)}%`)} of 50 limit)`);

				if (monthStats.remainingSessions <= 5 && monthStats.remainingSessions > 0) {
					logger.warn(`⚠️  Only ${monthStats.remainingSessions} sessions remaining this month!`);
				}
				else if (monthStats.remainingSessions === 0) {
					logger.error(`🚨 Session limit reached! No sessions remaining this month.`);
				}
				else {
					logger.success(`${monthStats.remainingSessions} sessions remaining`);
				}

				// Show current session time remaining if available
				if (monthStats.currentSession?.hasActiveSession === true) {
					const timeColor = monthStats.currentSession.timeRemainingMs < 30 * 60 * 1000 ? 'yellow' : 'cyan'; // Yellow if less than 30 minutes
					logger.info(`🕒 Current session: ${pc[timeColor](monthStats.currentSession.timeRemainingFormatted)} remaining`);
				}

				// Monthly summary table
				const summaryTable = new Table({
					head: ['Metric', 'Value'],
					style: {
						head: ['cyan'],
					},
					colAligns: ['left', 'right'],
				});

				summaryTable.push(
					['Total Cost', formatCurrency(monthStats.totalCost)],
					['Total Tokens', formatNumber(monthStats.totalTokens)],
					['Avg Cost/Session', formatCurrency(monthStats.averageCostPerSession)],
					['Avg Tokens/Session', formatNumber(monthStats.averageTokensPerSession)],
				);

				log(summaryTable.toString());

				// Individual session windows table
				if (monthStats.windows.length > 0) {
					const windowsTable = new Table({
						head: [
							'Window Start',
							'Duration',
							'Messages',
							'Convos',
							'Input',
							'Output',
							'Cache C',
							'Cache R',
							'Total Tokens',
							'Cost (USD)',
						],
						style: {
							head: ['cyan'],
						},
						colAligns: [
							'left',
							'left',
							'right',
							'right',
							'right',
							'right',
							'right',
							'right',
							'right',
							'right',
						],
					});

					for (const window of monthStats.windows) {
						const startTime = new Date(window.startTime);
						const endTime = new Date(window.endTime);
						const duration = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60)); // minutes
						const durationStr = duration > 60
							? `${Math.floor(duration / 60)}h ${duration % 60}m`
							: `${duration}m`;

						const totalTokens = window.inputTokens + window.outputTokens
							+ window.cacheCreationTokens + window.cacheReadTokens;

						windowsTable.push([
							startTime.toLocaleString().substring(0, 16), // Remove seconds
							durationStr,
							formatNumber(window.messageCount),
							formatNumber(window.conversationCount),
							formatNumber(window.inputTokens),
							formatNumber(window.outputTokens),
							formatNumber(window.cacheCreationTokens),
							formatNumber(window.cacheReadTokens),
							formatNumber(totalTokens),
							formatCurrency(window.totalCost),
						]);
					}

					log(windowsTable.toString());
				}

				// Add spacing between months
				log('');
			}

			// Overall summary if multiple months
			if (sessionData.length > 1) {
				const totalSessions = sessionData.reduce((acc, month) => acc + month.totalSessions, 0);
				const totalCost = sessionData.reduce((acc, month) => acc + month.totalCost, 0);
				const totalTokens = sessionData.reduce((acc, month) => acc + month.totalTokens, 0);

				logger.info(pc.bold('Overall Summary:'));
				const overallTable = new Table({
					head: ['Metric', 'Value'],
					style: {
						head: ['cyan'],
					},
					colAligns: ['left', 'right'],
				});

				overallTable.push(
					['Total Sessions', formatNumber(totalSessions)],
					['Total Cost', formatCurrency(totalCost)],
					['Total Tokens', formatNumber(totalTokens)],
					['Avg Cost/Session', formatCurrency(totalSessions > 0 ? totalCost / totalSessions : 0)],
					['Avg Tokens/Session', formatNumber(totalSessions > 0 ? totalTokens / totalSessions : 0)],
				);

				log(overallTable.toString());
			}
		}
	},
});
