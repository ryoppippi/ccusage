import { Result } from '@praha/byethrow';
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
