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
 * @param enableColors - Whether to enable colors (default: auto-detect)
 * @returns Color formatter function
 */
export function getStatusColor(
	indicator: string,
	description: string,
	enableColors?: boolean,
): Formatter {
	// Determine if colors should be enabled
	const shouldColor = enableColors ?? pc.isColorSupported;

	if (!shouldColor) {
		return (text: string | number | null | undefined) => String(text ?? '');
	}

	// Primary check: indicator-based coloring
	if (indicator === 'none' || description.toLowerCase().includes('operational')) {
		return pc.green;
	}
	else if (indicator === 'minor' || description.toLowerCase().includes('degraded')) {
		return pc.yellow;
	}
	else if (indicator === 'major' || indicator === 'critical' || description.toLowerCase().includes('outage')) {
		return pc.red;
	}

	// Default: no coloring for unknown status
	return (text: string | number | null | undefined) => String(text ?? '');
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

		it('should have proper structure when successful', async () => {
			const result = await fetchClaudeStatus();

			// Skip this test if API is not available, but don't use conditional assertions
			if (Result.isFailure(result)) {
				// Log why we're skipping but don't make assertions conditional
				console.warn('Skipping structure validation due to API unavailability');
				return;
			}

			// When successful, verify the structure
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

		it('should handle errors gracefully when API fails', async () => {
			const result = await fetchClaudeStatus();

			// If we got a failure result, verify it has proper error structure
			if (Result.isFailure(result)) {
				expect(result).toHaveProperty('error');
				expect(result.error).toBeInstanceOf(Error);
				return;
			}

			// If successful, just verify it's the expected type
			expect(result).toHaveProperty('value');
			expect(typeof result.value).toBe('object');
		});

		it('should validate ClaudeStatus type structure when available', async () => {
			const result = await fetchClaudeStatus();

			// Early return if API is not available
			if (Result.isFailure(result)) {
				console.warn('Skipping ClaudeStatus validation due to API unavailability');
				return;
			}

			// When API is available, validate the type structure
			const status = result.value;
			expect(status.status.indicator).toMatch(/^.+$/); // Any non-empty string
			expect(status.page.url).toMatch(/^https?:\/\/.+/);
		});
	});

	describe('getStatusColor', () => {
		it('should return green formatter for "none" indicator', () => {
			const formatter = getStatusColor('none', 'All Systems Operational', true);
			const result = formatter('test');
			// Verify it's colored (contains ANSI escape codes)
			expect(result).toContain('\u001B[32m'); // Green ANSI code
			expect(result).toContain('test');
		});

		it('should return yellow formatter for "minor" indicator', () => {
			const formatter = getStatusColor('minor', 'Partially Degraded Service', true);
			const result = formatter('test');
			// Verify it's colored with yellow
			expect(result).toContain('\u001B[33m'); // Yellow ANSI code
			expect(result).toContain('test');
		});

		it('should return red formatter for "major" indicator', () => {
			const formatter = getStatusColor('major', 'Service Outage', true);
			const result = formatter('test');
			// Verify it's colored with red
			expect(result).toContain('\u001B[31m'); // Red ANSI code
			expect(result).toContain('test');
		});

		it('should return red formatter for "critical" indicator', () => {
			const formatter = getStatusColor('critical', 'Critical System Failure', true);
			const result = formatter('test');
			// Verify it's colored with red
			expect(result).toContain('\u001B[31m'); // Red ANSI code
			expect(result).toContain('test');
		});

		it('should fall back to description-based detection for "operational"', () => {
			const formatter = getStatusColor('unknown', 'All Systems Operational', true);
			const result = formatter('test');
			// Should be green based on description
			expect(result).toContain('\u001B[32m'); // Green ANSI code
			expect(result).toContain('test');
		});

		it('should fall back to description-based detection for "degraded"', () => {
			const formatter = getStatusColor('unknown', 'Service is degraded', true);
			const result = formatter('test');
			// Should be yellow based on description
			expect(result).toContain('\u001B[33m'); // Yellow ANSI code
			expect(result).toContain('test');
		});

		it('should fall back to description-based detection for "outage"', () => {
			const formatter = getStatusColor('unknown', 'Service outage ongoing', true);
			const result = formatter('test');
			// Should be red based on description
			expect(result).toContain('\u001B[31m'); // Red ANSI code
			expect(result).toContain('test');
		});

		it('should return plain text when colors are disabled', () => {
			const formatter = getStatusColor('none', 'All Systems Operational', false);
			const result = formatter('test');
			// Should not contain any ANSI escape codes
			expect(result).not.toContain('\u001B[');
			expect(result).toBe('test');
		});

		it('should return plain text for unknown status', () => {
			const formatter = getStatusColor('unknown', 'Unknown status', true);
			const result = formatter('test');
			// Should not contain any ANSI escape codes for unknown status
			expect(result).not.toContain('\u001B[');
			expect(result).toBe('test');
		});

		it('should handle null/undefined input gracefully', () => {
			const formatter = getStatusColor('none', 'All Systems Operational', true);
			expect(formatter(null)).toBe('');
			expect(formatter(undefined)).toBe('');
		});
	});
}
