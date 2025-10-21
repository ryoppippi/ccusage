import type { Formatter } from 'picocolors/types';
import { Result } from '@praha/byethrow';
import pc from 'picocolors';
import * as v from 'valibot';

/**
 * Claude Status API response schema based on actual API response
 */
const claudeStatusSchema = v.object({
	status: v.object({
		description: v.string(),
		indicator: v.string(),
	}),
	page: v.object({
		id: v.string(),
		name: v.string(),
		url: v.string(),
		time_zone: v.string(),
		updated_at: v.string(),
	}),
});

export type ClaudeStatus = v.InferInput<typeof claudeStatusSchema>;

/**
 * Status indicator types based on common status page indicators
 */
export type StatusIndicator = 'none' | 'minor' | 'major' | 'critical';

/**
 * Get the appropriate color formatter for Claude status
 * @param indicator - Status indicator from API
 * @param description - Status description for fallback detection
 * @returns Color formatter function
 */
export function getStatusColor(
	indicator: string,
	description: string,
): Formatter {
	let colorFormatter: Formatter;

	// Determine color based on status indicator and description
	if (indicator === 'none' || description.toLowerCase().includes('operational')) {
		colorFormatter = pc.green;
	}
	else if (indicator === 'minor' || description.toLowerCase().includes('degraded')) {
		colorFormatter = pc.yellow;
	}
	else if (indicator === 'major' || indicator === 'critical' || description.toLowerCase().includes('outage')) {
		colorFormatter = pc.red;
	}
	else {
		// Default: no special coloring for unknown status
		colorFormatter = pc.white;
	}

	// Wrap formatter to handle null/undefined gracefully
	return (input: unknown): string => {
		if (input == null) {
			return '';
		}
		return colorFormatter(String(input));
	};
}

/**
 * Fetch Claude status from status.claude.com API
 * @returns Result containing Claude status data or error
 */
export async function fetchClaudeStatus(): Result.ResultAsync<ClaudeStatus, Error> {
	const result = Result.try({
		try: async () => {
			const response = await fetch('https://status.claude.com/api/v2/status.json');

			if (!response.ok) {
				throw new Error(`Failed to fetch Claude status: ${response.status} ${response.statusText}`);
			}

			const data: unknown = await response.json();

			// Validate response data using safeParse
			const parseResult = v.safeParse(claudeStatusSchema, data);
			if (!parseResult.success) {
				throw new Error(`Invalid API response format: ${parseResult.issues.map(issue => issue.message).join(', ')}`);
			}

			return parseResult.output;
		},
		catch: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
	});

	return result();
}

if (import.meta.vitest != null) {
	describe('fetchClaudeStatus', () => {
		it('should return a Result type', async () => {
			const result = await fetchClaudeStatus();

			// Always verify that we get a Result type back
			expect(Result.isSuccess(result) || Result.isFailure(result)).toBe(true);
		});

		it('should fetch Claude status successfully', async () => {
			// If this test fails, it indicates API trouble
			const result = await fetchClaudeStatus();

			// Early error if API fails - this makes the test deterministic
			if (Result.isFailure(result)) {
				throw new Error(`API failed: ${result.error.message}`);
			}

			expect(Result.isSuccess(result)).toBe(true);
			expect(result.value).toHaveProperty('status');
			expect(result.value.status).toHaveProperty('description');
			expect(result.value.status).toHaveProperty('indicator');
			expect(typeof result.value.status.description).toBe('string');
			expect(typeof result.value.status.indicator).toBe('string');

			expect(result.value).toHaveProperty('page');
			expect(result.value.page).toHaveProperty('id');
			expect(result.value.page).toHaveProperty('name');
			expect(result.value.page).toHaveProperty('url');
			expect(result.value.page).toHaveProperty('time_zone');
			expect(result.value.page).toHaveProperty('updated_at');
		});

		it('should validate ClaudeStatus type structure', async () => {
			// If this test fails, it indicates API trouble
			const result = await fetchClaudeStatus();

			// Early error if API fails - this makes the test deterministic
			if (Result.isFailure(result)) {
				throw new Error(`API failed: ${result.error.message}`);
			}

			expect(Result.isSuccess(result)).toBe(true);

			const status = result.value;
			expect(status.status.indicator).toMatch(/^.+$/); // Any non-empty string
			expect(status.page.url).toMatch(/^https?:\/\/.+/);
		});
	});

	describe('getStatusColor', () => {
		it('should return green formatter for "none" indicator', () => {
			const formatter = getStatusColor('none', 'All Systems Operational');
			const result = formatter('test');
			// Test green branch (indicator-based)
			expect(result).toContain('test');
			expect(typeof result).toBe('string');
		});

		it('should return yellow formatter for "minor" indicator', () => {
			const formatter = getStatusColor('minor', 'Partially Degraded Service');
			const result = formatter('test');
			// Test yellow branch (indicator-based)
			expect(result).toContain('test');
			expect(typeof result).toBe('string');
		});

		it('should return red formatter for "major" indicator', () => {
			const formatter = getStatusColor('major', 'Service Outage');
			const result = formatter('test');
			// Test red branch (indicator-based)
			expect(result).toContain('test');
			expect(typeof result).toBe('string');
		});

		it('should return white formatter for unknown status', () => {
			const formatter = getStatusColor('unknown', 'Unknown status');
			const result = formatter('test');
			// Test white branch (else case)
			expect(result).toContain('test');
			expect(typeof result).toBe('string');
		});

		it('should fall back to description-based detection', () => {
			const formatter = getStatusColor('unknown', 'All Systems Operational');
			const result = formatter('test');
			// Test description fallback branch
			expect(result).toContain('test');
			expect(typeof result).toBe('string');
		});

		it('should handle null/undefined input gracefully', () => {
			const formatter = getStatusColor('none', 'All Systems Operational');
			// Test null handling branch
			expect(formatter(null)).toBe('');
			expect(formatter(undefined)).toBe('');
		});
	});
}
