/**
 * @fileoverview Debug utilities for cost calculation validation
 *
 * This module provides debugging tools for detecting mismatches between
 * pre-calculated costs and calculated costs based on token usage and model pricing.
 *
 * @module debug
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import { CLAUDE_PROJECTS_DIR_NAME, DEBUG_MATCH_THRESHOLD_PERCENT, USAGE_DATA_GLOB_PATTERN } from './_consts.ts';
import { getClaudePaths, usageDataSchema } from './data-loader.ts';
import { logger } from './logger.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

/**
 * Represents a pricing discrepancy between original and calculated costs
 */
type Discrepancy = {
	file: string;
	timestamp: string;
	model: string;
	originalCost: number;
	calculatedCost: number;
	difference: number;
	percentDiff: number;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
};

/**
 * Statistics about pricing mismatches across all usage data
 */
type MismatchStats = {
	totalEntries: number;
	entriesWithBoth: number;
	matches: number;
	mismatches: number;
	discrepancies: Discrepancy[];
	modelStats: Map<
		string,
		{
			total: number;
			matches: number;
			mismatches: number;
			avgPercentDiff: number;
		}
	>;
	versionStats: Map<
		string,
		{
			total: number;
			matches: number;
			mismatches: number;
			avgPercentDiff: number;
		}
	>;
};

/**
 * Analyzes usage data to detect pricing mismatches between stored and calculated costs
 * Compares pre-calculated costUSD values with costs calculated from token usage
 * @param claudePath - Optional path to Claude data directory
 * @returns Statistics about pricing mismatches found
 */
export async function detectMismatches(
	claudePath?: string,
): Promise<MismatchStats> {
	let claudeDir: string;
	if (claudePath != null && claudePath !== '') {
		claudeDir = claudePath;
	}
	else {
		const paths = getClaudePaths();
		if (paths.length === 0) {
			throw new Error('No valid Claude data directory found');
		}
		claudeDir = path.join(paths[0]!, CLAUDE_PROJECTS_DIR_NAME);
	}
	const files = await glob([USAGE_DATA_GLOB_PATTERN], {
		cwd: claudeDir,
		absolute: true,
	});

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = new PricingFetcher();

	const stats: MismatchStats = {
		totalEntries: 0,
		entriesWithBoth: 0,
		matches: 0,
		mismatches: 0,
		discrepancies: [],
		modelStats: new Map(),
		versionStats: new Map(),
	};

	for (const file of files) {
		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		for (const line of lines) {
			const parseParser = Result.try({
				try: () => JSON.parse(line) as unknown,
				catch: () => new Error('Invalid JSON'),
			});

			const parseResult = parseParser();
			if (Result.isFailure(parseResult)) {
				continue;
			}

			const schemaResult = usageDataSchema.safeParse(parseResult.value);

			if (!schemaResult.success) {
				continue;
			}

			const data = schemaResult.data;
			stats.totalEntries++;

			// Check if we have both costUSD and model
			if (
				data.costUSD !== undefined
				&& data.message.model != null
				&& data.message.model !== '<synthetic>'
			) {
				stats.entriesWithBoth++;

				const model = data.message.model;
				const calculatedCost = await Result.unwrap(fetcher.calculateCostFromTokens(
					data.message.usage,
					model,
				));

				// Only compare if we could calculate a cost
				const difference = Math.abs(data.costUSD - calculatedCost);
				const percentDiff
						= data.costUSD > 0 ? (difference / data.costUSD) * 100 : 0;

				// Update model statistics
				const modelStat = stats.modelStats.get(model) ?? {
					total: 0,
					matches: 0,
					mismatches: 0,
					avgPercentDiff: 0,
				};
				modelStat.total++;

				// Update version statistics if version is available
				if (data.version != null) {
					const versionStat = stats.versionStats.get(data.version) ?? {
						total: 0,
						matches: 0,
						mismatches: 0,
						avgPercentDiff: 0,
					};
					versionStat.total++;

					// Consider it a match if within the defined threshold (to account for floating point)
					if (percentDiff < DEBUG_MATCH_THRESHOLD_PERCENT) {
						versionStat.matches++;
					}
					else {
						versionStat.mismatches++;
					}

					// Update average percent difference for version
					versionStat.avgPercentDiff
								= (versionStat.avgPercentDiff * (versionStat.total - 1)
									+ percentDiff)
								/ versionStat.total;
					stats.versionStats.set(data.version, versionStat);
				}

				// Consider it a match if within 0.1% difference (to account for floating point)
				if (percentDiff < 0.1) {
					stats.matches++;
					modelStat.matches++;
				}
				else {
					stats.mismatches++;
					modelStat.mismatches++;
					stats.discrepancies.push({
						file: path.basename(file),
						timestamp: data.timestamp,
						model,
						originalCost: data.costUSD,
						calculatedCost,
						difference,
						percentDiff,
						usage: data.message.usage,
					});
				}

				// Update average percent difference
				modelStat.avgPercentDiff
							= (modelStat.avgPercentDiff * (modelStat.total - 1) + percentDiff)
								/ modelStat.total;
				stats.modelStats.set(model, modelStat);
			}
		}
	}

	return stats;
}

/**
 * Prints a detailed report of pricing mismatches to the console
 * @param stats - Mismatch statistics to report
 * @param sampleCount - Number of sample discrepancies to show (default: 5)
 */
export function printMismatchReport(
	stats: MismatchStats,
	sampleCount = 5,
): void {
	if (stats.entriesWithBoth === 0) {
		logger.info('No pricing data found to analyze.');
		return;
	}

	const matchRate = (stats.matches / stats.entriesWithBoth) * 100;

	logger.info('\n=== Pricing Mismatch Debug Report ===');
	logger.info(
		`Total entries processed: ${stats.totalEntries.toLocaleString()}`,
	);
	logger.info(
		`Entries with both costUSD and model: ${stats.entriesWithBoth.toLocaleString()}`,
	);
	logger.info(`Matches (within 0.1%): ${stats.matches.toLocaleString()}`);
	logger.info(`Mismatches: ${stats.mismatches.toLocaleString()}`);
	logger.info(`Match rate: ${matchRate.toFixed(2)}%`);

	// Show model-by-model breakdown if there are mismatches
	if (stats.mismatches > 0 && stats.modelStats.size > 0) {
		logger.info('\n=== Model Statistics ===');
		const sortedModels = Array.from(stats.modelStats.entries()).sort(
			(a, b) => b[1].mismatches - a[1].mismatches,
		);

		for (const [model, modelStat] of sortedModels) {
			if (modelStat.mismatches > 0) {
				const modelMatchRate = (modelStat.matches / modelStat.total) * 100;
				logger.info(`${model}:`);
				logger.info(`  Total entries: ${modelStat.total.toLocaleString()}`);
				logger.info(
					`  Matches: ${modelStat.matches.toLocaleString()} (${modelMatchRate.toFixed(1)}%)`,
				);
				logger.info(`  Mismatches: ${modelStat.mismatches.toLocaleString()}`);
				logger.info(
					`  Avg % difference: ${modelStat.avgPercentDiff.toFixed(1)}%`,
				);
			}
		}
	}

	// Show version statistics if there are mismatches
	if (stats.mismatches > 0 && stats.versionStats.size > 0) {
		logger.info('\n=== Version Statistics ===');
		const sortedVersions = Array.from(stats.versionStats.entries())
			.filter(([_, versionStat]) => versionStat.mismatches > 0)
			.sort((a, b) => b[1].mismatches - a[1].mismatches);

		for (const [version, versionStat] of sortedVersions) {
			const versionMatchRate = (versionStat.matches / versionStat.total) * 100;
			logger.info(`${version}:`);
			logger.info(`  Total entries: ${versionStat.total.toLocaleString()}`);
			logger.info(
				`  Matches: ${versionStat.matches.toLocaleString()} (${versionMatchRate.toFixed(1)}%)`,
			);
			logger.info(`  Mismatches: ${versionStat.mismatches.toLocaleString()}`);
			logger.info(
				`  Avg % difference: ${versionStat.avgPercentDiff.toFixed(1)}%`,
			);
		}
	}

	// Show sample discrepancies
	if (stats.discrepancies.length > 0 && sampleCount > 0) {
		logger.info(`\n=== Sample Discrepancies (first ${sampleCount}) ===`);
		const samples = stats.discrepancies.slice(0, sampleCount);

		for (const disc of samples) {
			logger.info(`File: ${disc.file}`);
			logger.info(`Timestamp: ${disc.timestamp}`);
			logger.info(`Model: ${disc.model}`);
			logger.info(`Original cost: $${disc.originalCost.toFixed(6)}`);
			logger.info(`Calculated cost: $${disc.calculatedCost.toFixed(6)}`);
			logger.info(
				`Difference: $${disc.difference.toFixed(6)} (${disc.percentDiff.toFixed(2)}%)`,
			);
			logger.info(`Tokens: ${JSON.stringify(disc.usage)}`);
			logger.info('---');
		}
	}
}

if (import.meta.vitest != null) {
	describe('debug.ts', () => {
		describe('detectMismatches', () => {
			it('should detect no mismatches when costs match', async () => {
				await using fixture = await createFixture({
					'test.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.00015, // 50 * 0.000003 = 0.00015 (matches calculated)
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: {
								input_tokens: 50,
								output_tokens: 0,
							},
						},
					}),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.totalEntries).toBe(1);
				expect(stats.entriesWithBoth).toBe(1);
				expect(stats.matches).toBe(1);
				expect(stats.mismatches).toBe(0);
				expect(stats.discrepancies).toHaveLength(0);
			});

			it('should detect mismatches when costs differ significantly', async () => {
				await using fixture = await createFixture({
					'test.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.1, // Significantly different from calculated cost
						version: '1.0.0',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: {
								input_tokens: 50,
								output_tokens: 10,
							},
						},
					}),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.totalEntries).toBe(1);
				expect(stats.entriesWithBoth).toBe(1);
				expect(stats.matches).toBe(0);
				expect(stats.mismatches).toBe(1);
				expect(stats.discrepancies).toHaveLength(1);

				const discrepancy = stats.discrepancies[0];
				expect(discrepancy).toBeDefined();
				expect(discrepancy?.file).toBe('test.jsonl');
				expect(discrepancy?.model).toBe('claude-sonnet-4-20250514');
				expect(discrepancy?.originalCost).toBe(0.1);
				expect(discrepancy?.percentDiff).toBeGreaterThan(0.1);
			});

			it('should handle entries without costUSD or model', async () => {
				await using fixture = await createFixture({
					'test.jsonl': [
						JSON.stringify({
							timestamp: '2024-01-01T12:00:00Z',
							// No costUSD
							message: {
								model: 'claude-sonnet-4-20250514',
								usage: { input_tokens: 50, output_tokens: 10 },
							},
						}),
						JSON.stringify({
							timestamp: '2024-01-01T12:00:00Z',
							costUSD: 0.001,
							message: {
							// No model
								usage: { input_tokens: 50, output_tokens: 10 },
							},
						}),
					].join('\n'),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.totalEntries).toBe(2);
				expect(stats.entriesWithBoth).toBe(0);
				expect(stats.matches).toBe(0);
				expect(stats.mismatches).toBe(0);
			});

			it('should skip synthetic models', async () => {
				await using fixture = await createFixture({
					'test.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.001,
						message: {
							model: '<synthetic>',
							usage: { input_tokens: 50, output_tokens: 10 },
						},
					}),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.totalEntries).toBe(1);
				expect(stats.entriesWithBoth).toBe(0);
			});

			it('should skip invalid JSON lines', async () => {
				await using fixture = await createFixture({
					'test.jsonl': [
						JSON.stringify({
							timestamp: '2024-01-01T12:00:00Z',
							costUSD: 0.001,
							message: {
								model: 'claude-sonnet-4-20250514',
								usage: { input_tokens: 50, output_tokens: 10 },
							},
						}),
						'invalid json line',
						JSON.stringify({
							timestamp: '2024-01-02T12:00:00Z',
							costUSD: 0.002,
							message: {
								model: 'claude-opus-4-20250514',
								usage: { input_tokens: 100, output_tokens: 20 },
							},
						}),
					].join('\n'),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.totalEntries).toBe(2); // Only valid entries counted
			});

			it('should detect mismatches for claude-opus-4-20250514', async () => {
				await using fixture = await createFixture({
					'opus-test.jsonl': JSON.stringify({
						timestamp: '2024-01-01T12:00:00Z',
						costUSD: 0.5, // Significantly different from calculated cost
						version: '1.0.0',
						message: {
							model: 'claude-opus-4-20250514',
							usage: {
								input_tokens: 100,
								output_tokens: 50,
							},
						},
					}),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.totalEntries).toBe(1);
				expect(stats.entriesWithBoth).toBe(1);
				expect(stats.mismatches).toBe(1);
				expect(stats.discrepancies).toHaveLength(1);

				const discrepancy = stats.discrepancies[0];
				expect(discrepancy).toBeDefined();
				expect(discrepancy?.file).toBe('opus-test.jsonl');
				expect(discrepancy?.model).toBe('claude-opus-4-20250514');
				expect(discrepancy?.originalCost).toBe(0.5);
				expect(discrepancy?.percentDiff).toBeGreaterThan(0.1);
			});

			it('should track model statistics', async () => {
				await using fixture = await createFixture({
					'test.jsonl': [
						JSON.stringify({
							timestamp: '2024-01-01T12:00:00Z',
							costUSD: 0.00015, // 50 * 0.000003 = 0.00015 (matches)
							message: {
								model: 'claude-sonnet-4-20250514',
								usage: { input_tokens: 50, output_tokens: 0 },
							},
						}),
						JSON.stringify({
							timestamp: '2024-01-02T12:00:00Z',
							costUSD: 0.001, // Mismatch with calculated cost (0.0003)
							message: {
								model: 'claude-sonnet-4-20250514',
								usage: { input_tokens: 50, output_tokens: 10 },
							},
						}),
					].join('\n'),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.modelStats.has('claude-sonnet-4-20250514')).toBe(true);
				const modelStat = stats.modelStats.get('claude-sonnet-4-20250514');
				expect(modelStat).toBeDefined();
				expect(modelStat?.total).toBe(2);
				expect(modelStat?.matches).toBe(1);
				expect(modelStat?.mismatches).toBe(1);
			});

			it('should track version statistics', async () => {
				await using fixture = await createFixture({
					'test.jsonl': [
						JSON.stringify({
							timestamp: '2024-01-01T12:00:00Z',
							costUSD: 0.00015, // 50 * 0.000003 = 0.00015 (matches)
							version: '1.0.0',
							message: {
								model: 'claude-sonnet-4-20250514',
								usage: { input_tokens: 50, output_tokens: 0 },
							},
						}),
						JSON.stringify({
							timestamp: '2024-01-02T12:00:00Z',
							costUSD: 0.001, // Mismatch with calculated cost (0.0003)
							version: '1.0.0',
							message: {
								model: 'claude-sonnet-4-20250514',
								usage: { input_tokens: 50, output_tokens: 10 },
							},
						}),
					].join('\n'),
				});

				const stats = await detectMismatches(fixture.path);

				expect(stats.versionStats.has('1.0.0')).toBe(true);
				const versionStat = stats.versionStats.get('1.0.0');
				expect(versionStat).toBeDefined();
				expect(versionStat?.total).toBe(2);
				expect(versionStat?.matches).toBe(1);
				expect(versionStat?.mismatches).toBe(1);
			});
		});

		describe('printMismatchReport', () => {
			it('should work without errors for basic cases', () => {
				const stats = {
					totalEntries: 10,
					entriesWithBoth: 0,
					matches: 0,
					mismatches: 0,
					discrepancies: [],
					modelStats: new Map(),
					versionStats: new Map(),
				};

				expect(() => printMismatchReport(stats)).not.toThrow();
			});

			it('should work with complex stats without errors', () => {
				const modelStats = new Map();
				modelStats.set('claude-sonnet-4-20250514', {
					total: 10,
					matches: 8,
					mismatches: 2,
					avgPercentDiff: 5.5,
				});

				const versionStats = new Map();
				versionStats.set('1.0.0', {
					total: 10,
					matches: 8,
					mismatches: 2,
					avgPercentDiff: 3.2,
				});

				const discrepancies = [
					{
						file: 'test1.jsonl',
						timestamp: '2024-01-01T12:00:00Z',
						model: 'claude-sonnet-4-20250514',
						originalCost: 0.001,
						calculatedCost: 0.0015,
						difference: 0.0005,
						percentDiff: 50.0,
						usage: { input_tokens: 100, output_tokens: 20 },
					},
				];

				const stats = {
					totalEntries: 10,
					entriesWithBoth: 10,
					matches: 8,
					mismatches: 2,
					discrepancies,
					modelStats,
					versionStats,
				};

				expect(() => printMismatchReport(stats)).not.toThrow();
			});

			it('should work with sample count limit', () => {
				const discrepancies = [
					{
						file: 'test.jsonl',
						timestamp: '2024-01-01T12:00:00Z',
						model: 'claude-sonnet-4-20250514',
						originalCost: 0.001,
						calculatedCost: 0.0015,
						difference: 0.0005,
						percentDiff: 50.0,
						usage: { input_tokens: 100, output_tokens: 20 },
					},
				];

				const stats = {
					totalEntries: 10,
					entriesWithBoth: 10,
					matches: 9,
					mismatches: 1,
					discrepancies,
					modelStats: new Map(),
					versionStats: new Map(),
				};

				expect(() => printMismatchReport(stats, 0)).not.toThrow();
				expect(() => printMismatchReport(stats, 1)).not.toThrow();
			});
		});
	});
}
