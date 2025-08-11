import process from 'node:process';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, pushBreakdownRows, ResponsiveTable } from '../_utils.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { formatDateCompact, loadSessionData, loadSessionUsageById } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	args: {
		...sharedCommandConfig.args,
		id: {
			type: 'string',
			short: 'i',
			description: 'Load usage data for a specific session ID',
		},
	},
	toKebab: true,
	async run(ctx) {
		// --jq implies --json
		const useJson = ctx.values.json || ctx.values.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Handle specific session ID lookup
		if (ctx.values.id != null) {
			const sessionUsage = await loadSessionUsageById(ctx.values.id, {
				mode: ctx.values.mode,
				offline: ctx.values.offline,
			});

			if (sessionUsage == null) {
				if (useJson) {
					log(JSON.stringify(null));
				}
				else {
					logger.warn(`No session found with ID: ${ctx.values.id}`);
				}
				process.exit(0);
			}

			if (useJson) {
				const jsonOutput = {
					sessionId: ctx.values.id,
					totalCost: sessionUsage.totalCost,
					entries: sessionUsage.entries.map(entry => ({
						timestamp: entry.timestamp,
						inputTokens: entry.message.usage.input_tokens,
						outputTokens: entry.message.usage.output_tokens,
						cacheCreationTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
						cacheReadTokens: entry.message.usage.cache_read_input_tokens ?? 0,
						model: entry.message.model ?? 'unknown',
						costUSD: entry.costUSD ?? 0,
					})),
				};

				// Process with jq if specified
				if (ctx.values.jq != null) {
					const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
					if (Result.isFailure(jqResult)) {
						logger.error((jqResult.error).message);
						process.exit(1);
					}
					log(jqResult.value);
				}
				else {
					log(JSON.stringify(jsonOutput, null, 2));
				}
			}
			else {
				// Print header
				logger.box(`Claude Code Session Usage - ${ctx.values.id}`);

				// Show session summary
				const totalTokens = sessionUsage.entries.reduce((sum, entry) =>
					sum + entry.message.usage.input_tokens + entry.message.usage.output_tokens
					+ (entry.message.usage.cache_creation_input_tokens ?? 0)
					+ (entry.message.usage.cache_read_input_tokens ?? 0), 0);

				log(`Total Cost: ${formatCurrency(sessionUsage.totalCost)}`);
				log(`Total Tokens: ${formatNumber(totalTokens)}`);
				log(`Total Entries: ${sessionUsage.entries.length}`);
				log('');

				// Show individual entries
				if (sessionUsage.entries.length > 0) {
					const table = new ResponsiveTable({
						head: [
							'Timestamp',
							'Model',
							'Input',
							'Output',
							'Cache Create',
							'Cache Read',
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
						],
					});

					for (const entry of sessionUsage.entries) {
						table.push([
							new Date(entry.timestamp).toISOString(),
							entry.message.model ?? 'unknown',
							formatNumber(entry.message.usage.input_tokens),
							formatNumber(entry.message.usage.output_tokens),
							formatNumber(entry.message.usage.cache_creation_input_tokens ?? 0),
							formatNumber(entry.message.usage.cache_read_input_tokens ?? 0),
							formatCurrency(entry.costUSD ?? 0),
						]);
					}

					log(table.toString());
				}
			}
			return;
		}

		// Original session listing logic
		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
		});

		if (sessionData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (ctx.values.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map(data => ({
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
					projectPath: data.projectPath,
				})),
				totals: createTotalsObject(totals),
			};

			// Process with jq if specified
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error((jqResult.error).message);
					process.exit(1);
				}
				log(jqResult.value);
			}
			else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Session',
					'Models',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
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
					'left',
				],
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, ctx.values.timezone, ctx.values.locale),
				compactHead: [
					'Session',
					'Models',
					'Input',
					'Output',
					'Cost (USD)',
					'Last Activity',
				],
				compactColAligns: [
					'left',
					'left',
					'right',
					'right',
					'right',
					'left',
				],
				compactThreshold: 100,
			});

			// Add session data
			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				// Main row
				table.push([
					sessionDisplay,
					formatModelsDisplayMultiline(data.modelsUsed),
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.cacheCreationTokens),
					formatNumber(data.cacheReadTokens),
					formatNumber(getTotalTokens(data)),
					formatCurrency(data.totalCost),
					data.lastActivity,
				]);

				// Add model breakdown rows if flag is set
				if (ctx.values.breakdown) {
					// Session has 1 extra column before data and 1 trailing column
					pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
				}
			}

			// Add empty row for visual separation before totals
			table.push([
				'',
				'',
				'',
				'',
				'',
				'',
				'',
				'',
				'',
			]);

			// Add totals
			table.push([
				pc.yellow('Total'),
				'', // Empty for Models column in totals
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(totals))),
				pc.yellow(formatCurrency(totals.totalCost)),
				'',
			]);

			log(table.toString());

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});

if (import.meta.vitest != null) {
	const vitest = import('vitest');

	void vitest.then(({ describe, it, expect, vi, afterEach }) => {
		describe('sessionCommand --id functionality', () => {
			afterEach(() => {
				vi.unstubAllEnvs();
			});

			it('shows session data using --id option', async () => {
				const { createFixture } = await import('fs-fixture');
				const path = await import('node:path');

				await using fixture = await createFixture({
					'.claude': {
						projects: {
							'test-project': {
								'session-123.jsonl': `${JSON.stringify({
									timestamp: '2024-01-01T00:00:00Z',
									sessionId: 'session-123',
									message: {
										usage: {
											input_tokens: 100,
											output_tokens: 50,
											cache_creation_input_tokens: 10,
											cache_read_input_tokens: 20,
										},
										model: 'claude-sonnet-4-20250514',
									},
									costUSD: 0.5,
								})}\n${JSON.stringify({
									timestamp: '2024-01-01T01:00:00Z',
									sessionId: 'session-123',
									message: {
										usage: {
											input_tokens: 200,
											output_tokens: 100,
										},
										model: 'claude-sonnet-4-20250514',
									},
									costUSD: 1.0,
								})}`,
							},
						},
					},
				});

				vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(fixture.path, '.claude'));

				// Test that we can access the loadSessionUsageById functionality through the command
				const sessionUsage = await loadSessionUsageById('session-123', { mode: 'display', offline: true });

				expect(sessionUsage).not.toBeNull();
				expect(sessionUsage?.totalCost).toBe(1.5);
				expect(sessionUsage?.entries).toHaveLength(2);

				// Verify the first entry has the expected structure
				const firstEntry = sessionUsage?.entries[0];
				expect(firstEntry?.message.usage.input_tokens).toBe(100);
				expect(firstEntry?.message.usage.output_tokens).toBe(50);
				expect(firstEntry?.message.usage.cache_creation_input_tokens).toBe(10);
				expect(firstEntry?.message.usage.cache_read_input_tokens).toBe(20);
				expect(firstEntry?.message.model).toBe('claude-sonnet-4-20250514');
			});

			it('returns null for non-existent session ID', async () => {
				const { createFixture } = await import('fs-fixture');
				const path = await import('node:path');

				await using fixture = await createFixture({
					'.claude': {
						projects: {},
					},
				});

				vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(fixture.path, '.claude'));

				const sessionUsage = await loadSessionUsageById('non-existent-session', { mode: 'display', offline: true });
				expect(sessionUsage).toBeNull();
			});

			it('verifies the --id option is properly defined in command args', () => {
				// Verify that the sessionCommand has the id argument properly configured
				expect(sessionCommand.args).toHaveProperty('id');
				expect(sessionCommand.args.id).toEqual({
					type: 'string',
					short: 'i',
					description: 'Load usage data for a specific session ID',
				});
			});

			it('validates command exports loadSessionUsageById for external use', async () => {
				// This test validates that the function we use is properly exported
				// This ensures the API contract for custom statusline implementations
				expect(loadSessionUsageById).toBeDefined();
				expect(typeof loadSessionUsageById).toBe('function');
			});
		});
	});
}
