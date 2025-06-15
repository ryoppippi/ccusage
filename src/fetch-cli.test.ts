import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { createFixture } from 'fs-fixture';
import { loadDailyUsageData, loadSessionData } from './data-loader.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

describe('--fetch CLI argument functionality', () => {
	describe('PricingFetcher reuse prevents multiple fetch attempts', () => {
		it('should demonstrate the fix prevents multiple URL fetch attempts', async () => {
			// This test demonstrates that the issue is fixed by showing
			// that PricingFetcher instances cache their results

			const mockFetch = jest.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => Promise.resolve({
						'test-model': {
							input_cost_per_token: 0.00001,
							output_cost_per_token: 0.00003,
						},
					}),
				});

			const originalFetch = globalThis.fetch;
			// eslint-disable-next-line ts/no-unsafe-assignment
			globalThis.fetch = mockFetch as any;

			try {
				// Create a shared PricingFetcher instance
				using pricingFetcher = new PricingFetcher('https://test-url.com/pricing.json');

				// First call should trigger fetch
				await pricingFetcher.fetchModelPricing();
				expect(mockFetch).toHaveBeenCalledTimes(1);

				// Second call should use cached result
				await pricingFetcher.fetchModelPricing();
				expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2

				// Third call should also use cached result
				await pricingFetcher.getModelPricing('test-model');
				expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2
			}
			finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('should verify that separate PricingFetcher instances fetch independently', async () => {
			const mockFetch = jest.fn()
				.mockResolvedValue({
					ok: true,
					json: async () => Promise.resolve({
						'test-model': {
							input_cost_per_token: 0.00001,
							output_cost_per_token: 0.00003,
						},
					}),
				});

			const originalFetch = globalThis.fetch;
			// eslint-disable-next-line ts/no-unsafe-assignment
			globalThis.fetch = mockFetch as any;

			try {
				// First PricingFetcher instance
				using fetcher1 = new PricingFetcher('https://test-url.com/pricing.json');
				await fetcher1.fetchModelPricing();
				expect(mockFetch).toHaveBeenCalledTimes(1);

				// Second PricingFetcher instance (separate from first)
				using fetcher2 = new PricingFetcher('https://test-url.com/pricing.json');
				await fetcher2.fetchModelPricing();
				expect(mockFetch).toHaveBeenCalledTimes(2); // Now 2 fetches
			}
			finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe('Custom pricing source integration', () => {
		let tempDir: string;
		let testPricingFile: string;

		beforeEach(async () => {
			tempDir = tmpdir();
			testPricingFile = join(tempDir, 'test-pricing.json');
		});

		afterEach(async () => {
			try {
				await unlink(testPricingFile);
			}
			catch {
				// Ignore cleanup errors
			}
		});

		it('should use custom local pricing file for cost calculations', async () => {
			const customPricing = {
				'claude-sonnet-4-custom': {
					input_cost_per_token: 0.00005,
					output_cost_per_token: 0.00015,
				},
			};

			await writeFile(testPricingFile, JSON.stringify(customPricing));

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						'session-1': {
							'usage1.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								message: {
									usage: { input_tokens: 1000, output_tokens: 500 },
									model: 'claude-sonnet-4-custom',
								},
							}),
						},
					},
				},
			});

			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'calculate',
				fetch: testPricingFile,
			});

			expect(dailyData).toHaveLength(1);

			// Cost should be calculated using custom pricing: 1000 * 0.00005 + 500 * 0.00015 = 0.125
			expect(dailyData[0]?.totalCost).toBeCloseTo(0.125);
		});

		it('should handle session data with custom pricing file', async () => {
			const customPricing = {
				'test-model': {
					input_cost_per_token: 0.00001,
					output_cost_per_token: 0.00003,
				},
			};

			await writeFile(testPricingFile, JSON.stringify(customPricing));

			await using fixture = await createFixture({
				projects: {
					'my-project': {
						'session-abc': {
							'conversation.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								message: {
									usage: { input_tokens: 2000, output_tokens: 1000 },
									model: 'test-model',
								},
							}),
						},
					},
				},
			});

			const sessionData = await loadSessionData({
				claudePath: fixture.path,
				mode: 'calculate',
				fetch: testPricingFile,
			});

			expect(sessionData).toHaveLength(1);

			// Cost should be: 2000 * 0.00001 + 1000 * 0.00003 = 0.05
			expect(sessionData[0]?.totalCost).toBeCloseTo(0.05);
			expect(sessionData[0]?.sessionId).toBe('session-abc');
		});

		it('should work with display mode and ignore custom pricing file', async () => {
			const customPricing = {
				'some-model': {
					input_cost_per_token: 999,
					output_cost_per_token: 999,
				},
			};

			await writeFile(testPricingFile, JSON.stringify(customPricing));

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						'session-1': {
							'usage1.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								message: {
									usage: { input_tokens: 1000, output_tokens: 500 },
									model: 'some-model',
								},
								costUSD: 0.02,
							}),
						},
					},
				},
			});

			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'display',
				fetch: testPricingFile,
			});

			expect(dailyData).toHaveLength(1);

			// Should use pre-calculated costUSD, not custom pricing
			expect(dailyData[0]?.totalCost).toBe(0.02);
		});

		it('should throw error for malformed custom pricing JSON', async () => {
			await writeFile(testPricingFile, 'invalid json content');

			// Test with PricingFetcher directly - should throw PricingSourceError
			using fetcher = new PricingFetcher(testPricingFile);
			expect(fetcher.fetchModelPricing()).rejects.toThrow('Failed to load custom pricing data');
		});

		it('should throw error for non-existent custom pricing file', async () => {
			const nonExistentFile = join(tempDir, 'does-not-exist.json');

			// Test with PricingFetcher directly - should throw PricingSourceError
			using fetcher = new PricingFetcher(nonExistentFile);
			expect(fetcher.fetchModelPricing()).rejects.toThrow('Failed to load custom pricing data');
		});
	});

	describe('Custom HTTPS URL support', () => {
		it('should detect HTTPS URLs correctly and throw error on failure', async () => {
			const httpsUrl = 'https://example.com/pricing.json';
			using fetcher = new PricingFetcher(httpsUrl);

			// Mock fetch to fail with network error
			const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
			const originalFetch = globalThis.fetch;
			// eslint-disable-next-line ts/no-unsafe-assignment
			globalThis.fetch = mockFetch as any;

			try {
				// Should throw error for custom URL failure
				expect(fetcher.fetchModelPricing()).rejects.toThrow('Failed to load custom pricing data');
				expect(mockFetch).toHaveBeenCalledWith(httpsUrl);
			}
			finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('should reject non-HTTPS URLs and throw error', async () => {
			// eslint-disable-next-line ryoppippi/no-http-url
			const httpUrl = 'http://example.com/pricing.json';
			using fetcher = new PricingFetcher(httpUrl);

			// Should not try to fetch HTTP URLs (only HTTPS supported)
			const mockFetch = jest.fn();
			const originalFetch = globalThis.fetch;
			// eslint-disable-next-line ts/no-unsafe-assignment
			globalThis.fetch = mockFetch as any;

			try {
				// Should throw error when trying to load non-HTTPS URL as file
				expect(fetcher.fetchModelPricing()).rejects.toThrow('Failed to load custom pricing data');
				// Should not have called fetch since it's not HTTPS
				expect(mockFetch).not.toHaveBeenCalled();
			}
			finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe('Auto mode with custom pricing', () => {
		let tempDir: string;
		let testPricingFile: string;

		beforeEach(async () => {
			tempDir = tmpdir();
			testPricingFile = join(tempDir, 'test-pricing.json');
		});

		afterEach(async () => {
			try {
				await unlink(testPricingFile);
			}
			catch {
				// Ignore cleanup errors
			}
		});

		it('should prefer costUSD over custom pricing in auto mode', async () => {
			const customPricing = {
				'claude-sonnet-4-20250514': {
					input_cost_per_token: 999,
					output_cost_per_token: 999,
				},
			};

			await writeFile(testPricingFile, JSON.stringify(customPricing));

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						'session-1': {
							'usage1.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								message: {
									usage: { input_tokens: 1000, output_tokens: 500 },
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.025,
							}),
						},
					},
				},
			});

			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'auto',
				fetch: testPricingFile,
			});

			expect(dailyData).toHaveLength(1);

			// Should use costUSD (0.025) instead of calculating with custom pricing (would be ~1500)
			expect(dailyData[0]?.totalCost).toBe(0.025);
		});

		it('should fall back to custom pricing when costUSD is missing in auto mode', async () => {
			const customPricing = {
				'claude-sonnet-4-custom': {
					input_cost_per_token: 0.00002,
					output_cost_per_token: 0.00006,
				},
			};

			await writeFile(testPricingFile, JSON.stringify(customPricing));

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						'session-1': {
							'usage1.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								message: {
									usage: { input_tokens: 1000, output_tokens: 500 },
									model: 'claude-sonnet-4-custom',
								},
								// No costUSD field
							}),
						},
					},
				},
			});

			const dailyData = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'auto',
				fetch: testPricingFile,
			});

			expect(dailyData).toHaveLength(1);

			// Should calculate using custom pricing: 1000 * 0.00002 + 500 * 0.00006 = 0.05
			expect(dailyData[0]?.totalCost).toBeCloseTo(0.05);
		});
	});
});
