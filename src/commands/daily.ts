import type { DailyProjectOutput } from '../_json-output-types.ts';
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
import { formatDateCompact, loadDailyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Group daily usage data by project for JSON output
 */
function groupByProject(dailyData: ReturnType<typeof loadDailyUsageData> extends Promise<infer T> ? T : never): Record<string, DailyProjectOutput[]> {
	const projects: Record<string, DailyProjectOutput[]> = {};

	for (const data of dailyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push({
			date: data.date,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			cacheCreationTokens: data.cacheCreationTokens,
			cacheReadTokens: data.cacheReadTokens,
			totalTokens: getTotalTokens(data),
			totalCost: data.totalCost,
			modelsUsed: data.modelsUsed,
			modelBreakdowns: data.modelBreakdowns,
		});
	}

	return projects;
}

/**
 * Group daily usage data by project for table display
 */
type DailyData = Awaited<ReturnType<typeof loadDailyUsageData>>;

function groupDataByProject(dailyData: DailyData): Record<string, DailyData> {
	const projects: Record<string, DailyData> = {};

	for (const data of dailyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push(data);
	}

	return projects;
}

export const dailyCommand = define({
	name: 'daily',
	description: 'Show usage report grouped by date',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Show usage breakdown by project/instance',
			default: false,
		},
		project: {
			type: 'string',
			short: 'p',
			description: 'Filter to specific project name',
		},
	},
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const dailyData = await loadDailyUsageData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			groupByProject: ctx.values.instances,
			project: ctx.values.project,
		});

		if (dailyData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(dailyData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = ctx.values.instances && dailyData.some(d => d.project != null)
				? {
						projects: groupByProject(dailyData),
						totals: createTotalsObject(totals),
					}
				: {
						daily: dailyData.map(data => ({
							date: data.date,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: getTotalTokens(data),
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
							modelBreakdowns: data.modelBreakdowns,
							...(data.project != null && { project: data.project }),
						})),
						totals: createTotalsObject(totals),
					};
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - Daily');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Date',
					'Models',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
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
				],
				dateFormatter: formatDateCompact,
				compactHead: [
					'Date',
					'Models',
					'Input',
					'Output',
					'Cost (USD)',
				],
				compactColAligns: [
					'left',
					'left',
					'right',
					'right',
					'right',
				],
				compactThreshold: 100,
			});

			// Add daily data - group by project if instances flag is used
			if (ctx.values.instances && dailyData.some(d => d.project != null)) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(dailyData);

				let isFirstProject = true;
				for (const [projectName, projectData] of Object.entries(projectGroups)) {
					// Add project section header
					if (!isFirstProject) {
						// Add empty row for visual separation between projects
						table.push(['', '', '', '', '', '', '', '']);
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
					]);

					// Add data rows for this project
					for (const data of projectData) {
						table.push([
							data.date,
							formatModelsDisplayMultiline(data.modelsUsed),
							formatNumber(data.inputTokens),
							formatNumber(data.outputTokens),
							formatNumber(data.cacheCreationTokens),
							formatNumber(data.cacheReadTokens),
							formatNumber(getTotalTokens(data)),
							formatCurrency(data.totalCost),
						]);

						// Add model breakdown rows if flag is set
						if (ctx.values.breakdown) {
							pushBreakdownRows(table, data.modelBreakdowns);
						}
					}

					isFirstProject = false;
				}
			}
			else {
				// Standard display without project grouping
				for (const data of dailyData) {
					// Main row
					table.push([
						data.date,
						formatModelsDisplayMultiline(data.modelsUsed),
						formatNumber(data.inputTokens),
						formatNumber(data.outputTokens),
						formatNumber(data.cacheCreationTokens),
						formatNumber(data.cacheReadTokens),
						formatNumber(getTotalTokens(data)),
						formatCurrency(data.totalCost),
					]);

					// Add model breakdown rows if flag is set
					if (ctx.values.breakdown) {
						pushBreakdownRows(table, data.modelBreakdowns);
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
	const { createISOTimestamp, createDailyDate, createModelName } = await import('../_types.ts');

	describe('daily command --instances integration', () => {
		it('groups data by project when --instances flag is used', async () => {
			// Create test fixture with 2 projects
			await using fixture = await createFixture({
				projects: {
					'project-a': {
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
					'project-b': {
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

			// Test data loading with groupByProject: true (like --instances does)
			const { loadDailyUsageData } = await import('../data-loader.ts');
			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			// Should have 2 separate entries (one per project)
			expect(dailyData).toHaveLength(2);

			// Both entries should have project field populated
			expect(dailyData.every(d => d.project != null)).toBe(true);

			// Should have both projects represented
			const projects = new Set(dailyData.map(d => d.project));
			expect(projects.size).toBe(2);
			expect(projects.has('project-a')).toBe(true);
			expect(projects.has('project-b')).toBe(true);
		});

		it('generates project headers when rendering table with --instances', async () => {
			// Test the groupDataByProject function used for table rendering
			const mockDailyData = [
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-a',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-b',
					inputTokens: 2000,
					outputTokens: 1000,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.02,
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			// Test the groupDataByProject function
			const projectGroups = groupDataByProject(mockDailyData);

			// Should have 2 project groups
			expect(Object.keys(projectGroups)).toHaveLength(2);
			expect(projectGroups['project-a']).toBeDefined();
			expect(projectGroups['project-b']).toBeDefined();

			// Each group should contain correct data
			expect(projectGroups['project-a']).toHaveLength(1);
			expect(projectGroups['project-b']).toHaveLength(1);
			expect(projectGroups['project-a']![0]!.inputTokens).toBe(1000);
			expect(projectGroups['project-b']![0]!.inputTokens).toBe(2000);
		});

		it('produces correct JSON output structure with --instances', async () => {
			// Test the groupByProject function used for JSON output
			const mockDailyData = [
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-a',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-01'),
					project: 'project-b',
					inputTokens: 2000,
					outputTokens: 1000,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.02,
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			// Test the groupByProject function for JSON output
			const projectGroups = groupByProject(mockDailyData);

			// Should have 2 project groups
			expect(Object.keys(projectGroups)).toHaveLength(2);
			expect(projectGroups['project-a']).toBeDefined();
			expect(projectGroups['project-b']).toBeDefined();

			// Each group should be an array of project data
			expect(Array.isArray(projectGroups['project-a'])).toBe(true);
			expect(Array.isArray(projectGroups['project-b'])).toBe(true);
		});

		it('filters data by project when --project flag is used', async () => {
			// Create test fixture with 2 projects
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

			// Test filtering by specific project
			const { loadDailyUsageData } = await import('../data-loader.ts');
			const filteredData = await loadDailyUsageData({
				claudePath: fixture.path,
				project: 'project-alpha',
			});

			// Should only have data from project-alpha
			expect(filteredData).toHaveLength(1);
			expect(filteredData[0]?.project).toBe('project-alpha');
			expect(filteredData[0]?.inputTokens).toBe(1000);
			expect(filteredData[0]?.outputTokens).toBe(500);
			expect(filteredData[0]?.totalCost).toBe(0.01);
		});

		it('returns empty array when filtering by non-existent project', async () => {
			// Create test fixture with projects
			await using fixture = await createFixture({
				projects: {
					'existing-project': {
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
				},
			});

			// Test filtering by non-existent project
			const { loadDailyUsageData } = await import('../data-loader.ts');
			const filteredData = await loadDailyUsageData({
				claudePath: fixture.path,
				project: 'non-existent-project',
			});

			// Should return empty array
			expect(filteredData).toHaveLength(0);
		});

		it('automatically enables project grouping when --project filter is used', async () => {
			// Create test fixture with project
			await using fixture = await createFixture({
				projects: {
					'test-project': {
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
				},
			});

			// Test that project filtering automatically populates project field
			const { loadDailyUsageData } = await import('../data-loader.ts');
			const filteredData = await loadDailyUsageData({
				claudePath: fixture.path,
				project: 'test-project',
				// Note: NOT setting groupByProject: true, but project field should still be populated
			});

			// Should have project field populated due to automatic grouping
			expect(filteredData).toHaveLength(1);
			expect(filteredData[0]?.project).toBe('test-project');
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

			const { loadDailyUsageData } = await import('../data-loader.ts');
			const { calculateTotals, createTotalsObject } = await import('../calculate-cost.ts');

			// Test standard mode (no --instances)
			const standardData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: false,
			});

			const standardTotals = calculateTotals(standardData);

			// Simulate standard JSON output structure
			const standardJsonOutput = {
				daily: standardData.map(data => ({
					date: data.date,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					...(data.project != null && { project: data.project }),
				})),
				totals: createTotalsObject(standardTotals),
			};

			// Test instances mode (--instances)
			const instancesData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			const instancesTotals = calculateTotals(instancesData);

			// Simulate --instances JSON output structure
			const instancesJsonOutput = instancesData.some(d => d.project != null)
				? {
						projects: groupByProject(instancesData),
						totals: createTotalsObject(instancesTotals),
					}
				: {
						daily: instancesData.map(data => ({
							date: data.date,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
							modelBreakdowns: data.modelBreakdowns,
							...(data.project != null && { project: data.project }),
						})),
						totals: createTotalsObject(instancesTotals),
					};

			// Verify different JSON structures
			expect('daily' in standardJsonOutput).toBe(true);
			expect('projects' in standardJsonOutput).toBe(false);
			expect('totals' in standardJsonOutput).toBe(true);

			expect('daily' in instancesJsonOutput).toBe(false);
			expect('projects' in instancesJsonOutput).toBe(true);
			expect('totals' in instancesJsonOutput).toBe(true);

			// Verify projects structure contains expected project keys
			if ('projects' in instancesJsonOutput) {
				const projects = instancesJsonOutput.projects as Record<string, any[]>;
				expect(Object.keys(projects)).toContain('project-alpha');
				expect(Object.keys(projects)).toContain('project-beta');
				expect(Array.isArray(projects['project-alpha'])).toBe(true);
				expect(Array.isArray(projects['project-beta'])).toBe(true);
			}

			// Verify daily structure is array format
			if ('daily' in standardJsonOutput) {
				expect(Array.isArray(standardJsonOutput.daily)).toBe(true);
				expect(standardJsonOutput.daily.length).toBeGreaterThan(0);
			}
		});

		it('correctly handles --instances and --project flag combination', async () => {
			// Create test fixture with multiple projects
			await using fixture = await createFixture({
				projects: {
					'target-project': {
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
					'other-project': {
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

			const { loadDailyUsageData } = await import('../data-loader.ts');

			// Test combining both flags: --instances --project target-project
			const combinedFlagsData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true, // --instances flag
				project: 'target-project', // --project flag
			});

			// Should only have data from target-project (project filtering works)
			expect(combinedFlagsData).toHaveLength(1);
			expect(combinedFlagsData[0]?.project).toBe('target-project');
			expect(combinedFlagsData[0]?.inputTokens).toBe(1000);
			expect(combinedFlagsData[0]?.outputTokens).toBe(500);
			expect(combinedFlagsData[0]?.totalCost).toBe(0.01);

			// Verify that project grouping was enabled (project field is populated)
			expect(combinedFlagsData[0]?.project).toBeDefined();

			// Test that filtering works correctly - should not include other-project data
			const allProjectsData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true, // --instances only, no project filter
			});

			// Without project filter, should have both projects
			expect(allProjectsData).toHaveLength(2);

			// With project filter, should only have target project
			expect(combinedFlagsData).toHaveLength(1);

			// Test JSON output structure with combined flags
			const { calculateTotals, createTotalsObject } = await import('../calculate-cost.ts');
			const totals = calculateTotals(combinedFlagsData);

			// Should produce projects structure (due to --instances) with only filtered project
			const jsonOutput = combinedFlagsData.some(d => d.project != null)
				? {
						projects: groupByProject(combinedFlagsData),
						totals: createTotalsObject(totals),
					}
				: {
						daily: combinedFlagsData.map(data => ({
							date: data.date,
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalTokens: data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens,
							totalCost: data.totalCost,
							modelsUsed: data.modelsUsed,
							modelBreakdowns: data.modelBreakdowns,
							...(data.project != null && { project: data.project }),
						})),
						totals: createTotalsObject(totals),
					};

			// Should use projects structure (because of --instances)
			expect('projects' in jsonOutput).toBe(true);
			expect('daily' in jsonOutput).toBe(false);

			// Should only contain the filtered project
			if ('projects' in jsonOutput) {
				const projects = jsonOutput.projects as Record<string, any[]>;
				expect(Object.keys(projects)).toHaveLength(1);
				expect(projects['target-project']).toBeDefined();
				expect(projects['other-project']).toBeUndefined();
				expect(Array.isArray(projects['target-project'])).toBe(true);
				expect(projects['target-project']).toHaveLength(1);
			}
		});

		it('handles empty state correctly with --instances and non-existent project', async () => {
			// Create test fixture with existing data
			await using fixture = await createFixture({
				projects: {
					'existing-project': {
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
				},
			});

			const { loadDailyUsageData } = await import('../data-loader.ts');

			// Test --instances with non-existent project (should return empty array)
			const emptyData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true, // --instances flag
				project: 'non-existent-project', // --project flag with non-existent project
			});

			// Should return empty array (no data matches the filter)
			expect(emptyData).toHaveLength(0);
			expect(Array.isArray(emptyData)).toBe(true);

			// Test that we have data when not filtering (sanity check)
			const allData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true,
			});
			expect(allData.length).toBeGreaterThan(0);

			// Test empty state JSON output structure for --instances mode
			const { calculateTotals, createTotalsObject } = await import('../calculate-cost.ts');
			const totals = calculateTotals(emptyData);

			// When data is empty but --instances was used, should still produce projects structure
			const jsonOutput = {
				projects: groupByProject(emptyData), // Will be empty object {}
				totals: createTotalsObject(totals),
			};

			// Verify empty projects structure
			expect(typeof jsonOutput.projects).toBe('object');
			expect(Object.keys(jsonOutput.projects)).toHaveLength(0);
			expect(jsonOutput.totals).toBeDefined();

			// Verify totals for empty data
			expect(totals.inputTokens).toBe(0);
			expect(totals.outputTokens).toBe(0);
			expect(totals.totalCost).toBe(0);

			// Test that empty state detection works correctly
			// This mimics the check in the command: if (dailyData.length === 0)
			expect(emptyData.length === 0).toBe(true);
		});

		it('applies formatProjectName when rendering project headers with --instances', async () => {
			// Create test fixture with complex project names that need formatting
			await using fixture = await createFixture({
				projects: {
					// Long complex project path that should be formatted
					'-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot': {
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
					// Simple project name that shouldn't change much
					'simple-project': {
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

			const { loadDailyUsageData } = await import('../data-loader.ts');
			const { formatProjectName } = await import('../_project-names.ts');

			// Load data with project grouping enabled
			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			// Test that groupDataByProject works with complex project names
			const projectGroups = groupDataByProject(dailyData);

			// Verify we have both projects
			expect(Object.keys(projectGroups)).toHaveLength(2);
			expect(projectGroups['-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot']).toBeDefined();
			expect(projectGroups['simple-project']).toBeDefined();

			// Test that formatProjectName processes the complex name correctly
			const complexProjectName = '-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot';
			const formattedComplexName = formatProjectName(complexProjectName);

			// This should format to something much shorter (based on existing tests in _project-names.ts)
			expect(formattedComplexName).toBe('configure-dependabot');
			expect(formattedComplexName.length).toBeLessThan(complexProjectName.length);

			// Test that simple project name passes through cleanly
			const simpleFormatted = formatProjectName('simple-project');
			expect(simpleFormatted).toBe('simple-project');

			// Verify project header rendering logic (simulates what happens in the command)
			for (const [projectName, projectData] of Object.entries(projectGroups)) {
				const headerText = `Project: ${formatProjectName(projectName)}`;

				if (projectName === complexProjectName) {
					// Complex name should be shortened
					expect(headerText).toBe('Project: configure-dependabot');
					expect(headerText.length).toBeLessThan(100); // Much shorter than original
				}
				else if (projectName === 'simple-project') {
					// Simple name should be unchanged
					expect(headerText).toBe('Project: simple-project');
				}

				// Verify that each project group has data
				expect(Array.isArray(projectData)).toBe(true);
				expect(projectData.length).toBeGreaterThan(0);
			}
		});

		it('works with project aliases when rendering project headers', async () => {
			// Test project alias functionality by setting environment variable
			const { PROJECT_ALIASES_ENV } = await import('../_consts.ts');
			const { clearAliasCache } = await import('../_project-names.ts');

			// Clear any existing alias cache
			clearAliasCache();

			// Set up aliases: raw project name = display alias
			process.env[PROJECT_ALIASES_ENV] = 'complex-project=My Complex Project,simple-proj=Simple Tool';

			await using fixture = await createFixture({
				projects: {
					'complex-project': {
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
					'simple-proj': {
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
					'no-alias-project': {
						session3: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-01T16:00:00Z'),
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
				},
			});

			const { loadDailyUsageData } = await import('../data-loader.ts');
			const { formatProjectName } = await import('../_project-names.ts');

			// Load data with project grouping
			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			const projectGroups = groupDataByProject(dailyData);

			// Test alias resolution
			expect(formatProjectName('complex-project')).toBe('My Complex Project');
			expect(formatProjectName('simple-proj')).toBe('Simple Tool');
			expect(formatProjectName('no-alias-project')).toBe('no-alias-project'); // No alias, unchanged

			// Verify project header rendering with aliases
			for (const [projectName] of Object.entries(projectGroups)) {
				const headerText = `Project: ${formatProjectName(projectName)}`;

				if (projectName === 'complex-project') {
					expect(headerText).toBe('Project: My Complex Project');
				}
				else if (projectName === 'simple-proj') {
					expect(headerText).toBe('Project: Simple Tool');
				}
				else if (projectName === 'no-alias-project') {
					expect(headerText).toBe('Project: no-alias-project');
				}
			}

			// Clean up environment
			delete process.env[PROJECT_ALIASES_ENV];
			clearAliasCache();
		});

		it('validates JSON output conforms to DailyProjectOutput interface', async () => {
			// Create test data that should match the interface exactly
			const mockDailyData = [
				{
					date: createDailyDate('2024-01-01'),
					project: 'test-project',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 100,
					cacheReadTokens: 200,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-02'),
					project: 'test-project',
					inputTokens: 800,
					outputTokens: 400,
					cacheCreationTokens: 50,
					cacheReadTokens: 150,
					totalCost: 0.008,
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			// Generate JSON output using groupByProject
			const projectGroups = groupByProject(mockDailyData);

			// Verify structure matches DailyProjectOutput interface
			expect(projectGroups).toHaveProperty('test-project');
			const projectData = projectGroups['test-project']!;
			expect(Array.isArray(projectData)).toBe(true);
			expect(projectData).toHaveLength(2);

			// Validate each entry matches DailyProjectOutput interface
			for (const entry of projectData) {
				// Required properties from DailyProjectOutput
				expect(entry).toHaveProperty('date');
				expect(entry).toHaveProperty('inputTokens');
				expect(entry).toHaveProperty('outputTokens');
				expect(entry).toHaveProperty('cacheCreationTokens');
				expect(entry).toHaveProperty('cacheReadTokens');
				expect(entry).toHaveProperty('totalTokens');
				expect(entry).toHaveProperty('totalCost');
				expect(entry).toHaveProperty('modelsUsed');
				expect(entry).toHaveProperty('modelBreakdowns');

				// Type validations
				expect(typeof entry.date).toBe('string'); // DailyDate is a branded string
				expect(typeof entry.inputTokens).toBe('number');
				expect(typeof entry.outputTokens).toBe('number');
				expect(typeof entry.cacheCreationTokens).toBe('number');
				expect(typeof entry.cacheReadTokens).toBe('number');
				expect(typeof entry.totalTokens).toBe('number');
				expect(typeof entry.totalCost).toBe('number');
				expect(Array.isArray(entry.modelsUsed)).toBe(true);
				expect(Array.isArray(entry.modelBreakdowns)).toBe(true);

				// Verify branded types are correctly used
				expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // DailyDate format
				for (const model of entry.modelsUsed) {
					expect(typeof model).toBe('string'); // ModelName is branded string
					expect(model).toMatch(/^claude-/); // Should start with 'claude-'
				}

				// Verify totalTokens calculation is correct
				const expectedTotal = entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
				expect(entry.totalTokens).toBe(expectedTotal);
			}

			// Verify specific values from mock data
			expect(projectData[0]!.inputTokens).toBe(1000);
			expect(projectData[0]!.outputTokens).toBe(500);
			expect(projectData[0]!.totalTokens).toBe(1800); // 1000 + 500 + 100 + 200
			expect(projectData[1]!.inputTokens).toBe(800);
			expect(projectData[1]!.outputTokens).toBe(400);
			expect(projectData[1]!.totalTokens).toBe(1400); // 800 + 400 + 50 + 150
		});
	});
}
