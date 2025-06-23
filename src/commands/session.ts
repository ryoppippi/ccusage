import process from 'node:process';
import { define } from 'gunshi';
import pc from 'picocolors';
import { formatProjectName } from '../_project-names.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { formatCurrency, formatModelsDisplayMultiline, formatNumber, pushBreakdownRows, ResponsiveTable } from '../_utils.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { formatDateCompact, loadSessionData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Group session usage data by project for JSON output
 */
function groupByProject(sessionData: ReturnType<typeof loadSessionData> extends Promise<infer T> ? T : never): Record<string, any[]> {
	const projects: Record<string, any[]> = {};

	for (const data of sessionData) {
		const projectName = data.projectPath ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push({
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
		});
	}

	return projects;
}

/**
 * Group session usage data by project for table display
 */
type SessionData = Awaited<ReturnType<typeof loadSessionData>>;

function groupDataByProject(sessionData: SessionData): Record<string, SessionData> {
	const projects: Record<string, SessionData> = {};

	for (const data of sessionData) {
		const projectName = data.projectPath ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push(data);
	}

	return projects;
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			groupByProject: ctx.values.instances,
			project: ctx.values.project,
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

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = ctx.values.instances
				? {
						projects: groupByProject(sessionData),
						totals: createTotalsObject(totals),
					}
				: {
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
			log(JSON.stringify(jsonOutput, null, 2));
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
				dateFormatter: formatDateCompact,
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

			// Add session data - group by project if instances flag is used
			if (ctx.values.instances) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(sessionData);

				let isFirstProject = true;
				for (const [projectName, projectData] of Object.entries(projectGroups)) {
					// Add project section header
					if (!isFirstProject) {
						// Add empty row for visual separation between projects
						table.push(['', '', '', '', '', '', '', '', '']);
					}

					// Add project header row
					table.push([
						pc.cyan(`Project: ${formatProjectName(projectName)}`),
						'',
						'',
						'',
						'',
						'',
						'',
						'',
						'',
					]);

					// Add data rows for this project
					for (const data of projectData) {
						const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

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

					isFirstProject = false;
				}
			}
			else {
				// Standard display without project grouping
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
	const { describe, it, expect } = import.meta.vitest;

	// eslint-disable-next-line antfu/no-top-level-await
	const { createFixture } = await import('fs-fixture');
	// eslint-disable-next-line antfu/no-top-level-await
	const { createISOTimestamp, createModelName } = await import('../_types.ts');

	describe('session command --instances integration', () => {
		it('groups data by project when --instances flag is used', async () => {
			// Create test fixture with 2 projects and multiple sessions
			await using fixture = await createFixture({
				projects: {
					'project-alpha': {
						session1: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
								message: {
									usage: {
										input_tokens: 1000,
										output_tokens: 500,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.01,
							}),
						},
						session2: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-01T11:00:00Z'),
								message: {
									usage: {
										input_tokens: 800,
										output_tokens: 400,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.008,
							}),
						},
					},
					'project-beta': {
						session3: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-01T14:00:00Z'),
								message: {
									usage: {
										input_tokens: 2000,
										output_tokens: 1000,
									},
									model: 'claude-opus-4-20250514',
								},
								costUSD: 0.02,
							}),
						},
					},
				},
			});

			// Test data loading with groupByProject: true (like --instances does)
			const { loadSessionData } = await import('../data-loader.ts');
			const sessionData = await loadSessionData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			// Should have 3 entries (2 sessions for project-alpha, 1 for project-beta)
			expect(sessionData).toHaveLength(3);

			// All entries should have projectPath field populated
			expect(sessionData.every(d => d.projectPath != null)).toBe(true);

			// Should have both projects represented
			const projects = new Set(sessionData.map(d => d.projectPath));
			expect(projects.size).toBe(2);
			expect(projects.has('project-alpha')).toBe(true);
			expect(projects.has('project-beta')).toBe(true);

			// Verify session grouping
			const alphaSessions = sessionData.filter(d => d.projectPath === 'project-alpha');
			const betaSessions = sessionData.filter(d => d.projectPath === 'project-beta');
			expect(alphaSessions).toHaveLength(2);
			expect(betaSessions).toHaveLength(1);
		});

		it('generates project headers when rendering table with --instances', async () => {
			// Test the groupDataByProject function used for table rendering
			const mockSessionData = [
				{
					sessionId: 'session1',
					projectPath: 'project-alpha',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					lastActivity: createISOTimestamp('2024-01-01T10:00:00Z'),
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					sessionId: 'session2',
					projectPath: 'project-beta',
					inputTokens: 2000,
					outputTokens: 1000,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.02,
					lastActivity: createISOTimestamp('2024-01-01T14:00:00Z'),
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			// Test the groupDataByProject function
			const projectGroups = groupDataByProject(mockSessionData);

			// Should have 2 project groups
			expect(Object.keys(projectGroups)).toHaveLength(2);
			expect(projectGroups['project-alpha']).toBeDefined();
			expect(projectGroups['project-beta']).toBeDefined();

			// Each group should contain correct data
			expect(projectGroups['project-alpha']).toHaveLength(1);
			expect(projectGroups['project-beta']).toHaveLength(1);
			expect(projectGroups['project-alpha']![0]!.inputTokens).toBe(1000);
			expect(projectGroups['project-beta']![0]!.inputTokens).toBe(2000);
		});

		it('produces different JSON structures for --instances vs standard mode', async () => {
			// Create test fixture with multiple projects
			await using fixture = await createFixture({
				projects: {
					'project-alpha': {
						session1: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
								message: {
									usage: {
										input_tokens: 1000,
										output_tokens: 500,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.01,
							}),
						},
					},
					'project-beta': {
						session2: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-01T14:00:00Z'),
								message: {
									usage: {
										input_tokens: 2000,
										output_tokens: 1000,
									},
									model: 'claude-opus-4-20250514',
								},
								costUSD: 0.02,
							}),
						},
					},
				},
			});

			const { loadSessionData } = await import('../data-loader.ts');
			const { calculateTotals, createTotalsObject } = await import('../calculate-cost.ts');

			// Test standard mode (no --instances)
			const standardData = await loadSessionData({
				claudePath: fixture.path,
				groupByProject: false,
			});

			const standardTotals = calculateTotals(standardData);

			// Simulate standard JSON output structure
			const standardJsonOutput = {
				sessions: standardData.map(data => ({
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					...(data.projectPath != null && { projectPath: data.projectPath }),
				})),
				totals: createTotalsObject(standardTotals),
			};

			// Test instances mode (--instances)
			const instancesData = await loadSessionData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			const instancesTotals = calculateTotals(instancesData);

			// Simulate --instances JSON output structure
			const instancesJsonOutput = instancesData.some(d => d.projectPath != null)
				? {
						projects: groupByProject(instancesData),
						totals: createTotalsObject(instancesTotals),
					}
				: {
						sessions: instancesData.map(data => ({
							sessionId: data.sessionId,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
							totalCost: data.totalCost,
							lastActivity: data.lastActivity,
							modelsUsed: data.modelsUsed,
							modelBreakdowns: data.modelBreakdowns,
							...(data.projectPath != null && { projectPath: data.projectPath }),
						})),
						totals: createTotalsObject(instancesTotals),
					};

			// Verify different JSON structures
			expect('sessions' in standardJsonOutput).toBe(true);
			expect('projects' in standardJsonOutput).toBe(false);
			expect('totals' in standardJsonOutput).toBe(true);

			expect('sessions' in instancesJsonOutput).toBe(false);
			expect('projects' in instancesJsonOutput).toBe(true);
			expect('totals' in instancesJsonOutput).toBe(true);

			// Verify projects structure contains expected project keys
			if ('projects' in instancesJsonOutput) {
				const projects = instancesJsonOutput.projects;
				expect(Object.keys(projects)).toContain('project-alpha');
				expect(Object.keys(projects)).toContain('project-beta');
				expect(Array.isArray(projects['project-alpha'])).toBe(true);
				expect(Array.isArray(projects['project-beta'])).toBe(true);
			}

			// Verify sessions structure is array format
			if ('sessions' in standardJsonOutput) {
				expect(Array.isArray(standardJsonOutput.sessions)).toBe(true);
				expect(standardJsonOutput.sessions.length).toBeGreaterThan(0);
			}
		});
	});
}
