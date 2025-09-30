/**
 * @fileoverview Token calculation utilities
 *
 * This module provides shared utilities for calculating token totals
 * across different token types. Used throughout the application to
 * ensure consistent token counting logic.
 */

/**
 * Token counts structure for raw usage data (uses InputTokens suffix)
 */
export type TokenCounts = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
};

/**
 * Token counts structure for aggregated data (uses shorter names)
 */
export type AggregatedTokenCounts = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
};

/**
 * Union type that supports both token count formats
 */
export type AnyTokenCounts = TokenCounts | AggregatedTokenCounts;

/**
 * Calculates the total number of tokens across all token types
 * Supports both raw usage data format and aggregated data format
 * @param tokenCounts - Object containing counts for each token type
 * @returns Total number of tokens
 */
export function getTotalTokens(tokenCounts: AnyTokenCounts): number {
	// Support both property naming conventions
	const cacheCreation = 'cacheCreationInputTokens' in tokenCounts
		? tokenCounts.cacheCreationInputTokens
		: (tokenCounts).cacheCreationTokens;

	const cacheRead = 'cacheReadInputTokens' in tokenCounts
		? tokenCounts.cacheReadInputTokens
		: (tokenCounts).cacheReadTokens;

	return (
		tokenCounts.inputTokens
		+ tokenCounts.outputTokens
		+ cacheCreation
		+ cacheRead
	);
}

// In-source testing
if (import.meta.vitest != null) {
	describe('getTotalTokens', () => {
		it('should sum all token types correctly (raw format)', () => {
			const tokens: TokenCounts = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheCreationInputTokens: 2000,
				cacheReadInputTokens: 300,
			};
			expect(getTotalTokens(tokens)).toBe(3800);
		});

		it('should sum all token types correctly (aggregated format)', () => {
			const tokens: AggregatedTokenCounts = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheCreationTokens: 2000,
				cacheReadTokens: 300,
			};
			expect(getTotalTokens(tokens)).toBe(3800);
		});

		it('should handle zero values (raw format)', () => {
			const tokens: TokenCounts = {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			};
			expect(getTotalTokens(tokens)).toBe(0);
		});

		it('should handle zero values (aggregated format)', () => {
			const tokens: AggregatedTokenCounts = {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
			};
			expect(getTotalTokens(tokens)).toBe(0);
		});

		it('should handle missing cache tokens (raw format)', () => {
			const tokens: TokenCounts = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			};
			expect(getTotalTokens(tokens)).toBe(1500);
		});

		it('should handle missing cache tokens (aggregated format)', () => {
			const tokens: AggregatedTokenCounts = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
			};
			expect(getTotalTokens(tokens)).toBe(1500);
		});
	});
}
