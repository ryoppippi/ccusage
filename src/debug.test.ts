import { createFixture } from 'fs-fixture';
import { detectMismatches, printMismatchReport } from './debug.ts';

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
			// Since we can't easily mock logger in Bun test, just verify the function runs without errors
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
