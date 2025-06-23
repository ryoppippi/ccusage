import type { MonthlyProjectOutput } from '../_json-output-types.ts';
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
import { formatDateCompact, loadMonthlyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

/**
 * Group monthly usage data by project for JSON output
 */
function groupByProject(monthlyData: ReturnType<typeof loadMonthlyUsageData> extends Promise<infer T> ? T : never): Record<string, MonthlyProjectOutput[]> {
	const projects: Record<string, MonthlyProjectOutput[]> = {};

	for (const data of monthlyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push({
			month: data.month,
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
 * Group monthly usage data by project for table display
 */
type MonthlyData = Awaited<ReturnType<typeof loadMonthlyUsageData>>;

function groupDataByProject(monthlyData: MonthlyData): Record<string, MonthlyData> {
	const projects: Record<string, MonthlyData> = {};

	for (const data of monthlyData) {
		const projectName = data.project ?? 'unknown';

		if (projects[projectName] == null) {
			projects[projectName] = [];
		}

		projects[projectName].push(data);
	}

	return projects;
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show usage report grouped by month',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const monthlyData = await loadMonthlyUsageData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			order: ctx.values.order,
			offline: ctx.values.offline,
			groupByProject: ctx.values.instances,
			project: ctx.values.project,
		});

		if (monthlyData.length === 0) {
			if (ctx.values.json) {
				const emptyOutput = {
					monthly: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalTokens: 0,
						totalCost: 0,
					},
				};
				log(JSON.stringify(emptyOutput, null, 2));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(monthlyData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = ctx.values.instances && monthlyData.some(d => d.project != null)
				? {
						projects: groupByProject(monthlyData),
						totals: createTotalsObject(totals),
					}
				: {
						monthly: monthlyData.map(data => ({
							month: data.month,
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
			logger.box('Claude Code Token Usage Report - Monthly');

			// Create table with compact mode support
			const table = new ResponsiveTable({
				head: [
					'Month',
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
					'Month',
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

			// Add monthly data - group by project if instances flag is used
			if (ctx.values.instances && monthlyData.some(d => d.project != null)) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(monthlyData);

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
							data.month,
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
				for (const data of monthlyData) {
					// Main row
					table.push([
						data.month,
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
	const { createISOTimestamp, createMonthlyDate, createModelName } = await import('../_types.ts');

	describe('monthly command --instances integration', () => {
		it('groups data by project when --instances flag is used', async () => {
			// Create test fixture with 2 projects across different months
			await using fixture = await createFixture({
				projects: {
					'project-alpha': {
						session1: {
							'usage.jsonl': JSON.stringify({
								timestamp: createISOTimestamp('2024-01-15T10:00:00Z'),
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
								timestamp: createISOTimestamp('2024-02-15T14:00:00Z'),
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
			const { loadMonthlyUsageData } = await import('../data-loader.ts');
			const monthlyData = await loadMonthlyUsageData({
				claudePath: fixture.path,
				groupByProject: true,
			});

			// Should have 2 separate entries (one per project per month)
			expect(monthlyData).toHaveLength(2);

			// Both entries should have project field populated
			expect(monthlyData.every(d => d.project != null)).toBe(true);

			// Should have both projects represented
			const projects = new Set(monthlyData.map(d => d.project));
			expect(projects.size).toBe(2);
			expect(projects.has('project-alpha')).toBe(true);
			expect(projects.has('project-beta')).toBe(true);
		});

		it('generates project headers when rendering table with --instances', async () => {
			// Test the groupDataByProject function used for table rendering
			const mockMonthlyData = [
				{
					month: createMonthlyDate('2024-01'),
					project: 'project-alpha',
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					month: createMonthlyDate('2024-01'),
					project: 'project-beta',
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
			const projectGroups = groupDataByProject(mockMonthlyData);

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
								timestamp: createISOTimestamp('2024-01-15T10:00:00Z'),
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
								timestamp: createISOTimestamp('2024-02-15T14:00:00Z'),
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

			const { loadMonthlyUsageData } = await import('../data-loader.ts');
			const { calculateTotals, createTotalsObject } = await import('../calculate-cost.ts');

			// Test standard mode (no --instances)
			const standardData = await loadMonthlyUsageData({
				claudePath: fixture.path,
				groupByProject: false,
			});

			const standardTotals = calculateTotals(standardData);

			// Simulate standard JSON output structure
			const standardJsonOutput = {
				monthly: standardData.map(data => ({
					month: data.month,
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
			const instancesData = await loadMonthlyUsageData({
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
						monthly: instancesData.map(data => ({
							month: data.month,
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
			expect('monthly' in standardJsonOutput).toBe(true);
			expect('projects' in standardJsonOutput).toBe(false);
			expect('totals' in standardJsonOutput).toBe(true);

			expect('monthly' in instancesJsonOutput).toBe(false);
			expect('projects' in instancesJsonOutput).toBe(true);
			expect('totals' in instancesJsonOutput).toBe(true);

			// Verify projects structure contains expected project keys
			if ('projects' in instancesJsonOutput) {
				const projects = instancesJsonOutput.projects;
				expect(projects).toBeDefined();
				expect(Object.keys(projects!)).toContain('project-alpha');
				expect(Object.keys(projects!)).toContain('project-beta');
				expect(Array.isArray(projects!['project-alpha'])).toBe(true);
				expect(Array.isArray(projects!['project-beta'])).toBe(true);
			}

			// Verify monthly structure is array format
			if ('monthly' in standardJsonOutput) {
				expect(Array.isArray(standardJsonOutput.monthly)).toBe(true);
				expect(standardJsonOutput.monthly.length).toBeGreaterThan(0);
			}
		});

		it('validates JSON output conforms to MonthlyProjectOutput interface', async () => {
			// Create test data that should match the interface exactly
			const { createMonthlyDate } = await import('../_types.ts');
			const mockMonthlyData = [
				{
					month: createMonthlyDate('2024-01'),
					project: 'test-project',
					inputTokens: 15000,
					outputTokens: 7500,
					cacheCreationTokens: 1000,
					cacheReadTokens: 2000,
					totalCost: 0.15,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					month: createMonthlyDate('2024-02'),
					project: 'test-project',
					inputTokens: 12000,
					outputTokens: 6000,
					cacheCreationTokens: 800,
					cacheReadTokens: 1600,
					totalCost: 0.12,
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			// Generate JSON output using groupByProject
			const projectGroups = groupByProject(mockMonthlyData);

			// Verify structure matches MonthlyProjectOutput interface
			expect(projectGroups).toHaveProperty('test-project');
			const projectData = projectGroups['test-project']!;
			expect(Array.isArray(projectData)).toBe(true);
			expect(projectData).toHaveLength(2);

			// Validate each entry matches MonthlyProjectOutput interface
			for (const entry of projectData) {
				// Required properties from MonthlyProjectOutput
				expect(entry).toHaveProperty('month');
				expect(entry).toHaveProperty('inputTokens');
				expect(entry).toHaveProperty('outputTokens');
				expect(entry).toHaveProperty('cacheCreationTokens');
				expect(entry).toHaveProperty('cacheReadTokens');
				expect(entry).toHaveProperty('totalTokens');
				expect(entry).toHaveProperty('totalCost');
				expect(entry).toHaveProperty('modelsUsed');
				expect(entry).toHaveProperty('modelBreakdowns');

				// Type validations
				expect(typeof entry.month).toBe('string'); // MonthlyDate is a branded string
				expect(typeof entry.inputTokens).toBe('number');
				expect(typeof entry.outputTokens).toBe('number');
				expect(typeof entry.cacheCreationTokens).toBe('number');
				expect(typeof entry.cacheReadTokens).toBe('number');
				expect(typeof entry.totalTokens).toBe('number');
				expect(typeof entry.totalCost).toBe('number');
				expect(Array.isArray(entry.modelsUsed)).toBe(true);
				expect(Array.isArray(entry.modelBreakdowns)).toBe(true);

				// Verify branded types are correctly used
				expect(entry.month).toMatch(/^\d{4}-\d{2}$/); // MonthlyDate format
				for (const model of entry.modelsUsed) {
					expect(typeof model).toBe('string'); // ModelName is branded string
					expect(model).toMatch(/^claude-/); // Should start with 'claude-'
				}

				// Verify totalTokens calculation is correct
				const expectedTotal = entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
				expect(entry.totalTokens).toBe(expectedTotal);
			}

			// Verify specific values from mock data
			expect(projectData[0]!.inputTokens).toBe(15000);
			expect(projectData[0]!.outputTokens).toBe(7500);
			expect(projectData[0]!.totalTokens).toBe(25500); // 15000 + 7500 + 1000 + 2000
			expect(projectData[1]!.inputTokens).toBe(12000);
			expect(projectData[1]!.outputTokens).toBe(6000);
			expect(projectData[1]!.totalTokens).toBe(20400); // 12000 + 6000 + 800 + 1600
		});
	});
}
