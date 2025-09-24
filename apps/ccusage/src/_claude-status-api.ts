import * as v from 'valibot';

/**
 * Claude Status API response schema based on actual API response
 */
export const claudeStatusSchema = v.object({
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
export async function fetchClaudeStatus(): Promise<{ success: true; value: ClaudeStatus } | { success: false; error: Error }> {
	try {
		const response = await fetch('https://status.claude.com/api/v2/status.json', {
			headers: {
				'User-Agent': 'ccusage-cli',
			},
		});

		if (!response.ok) {
			return { success: false, error: new Error(`Failed to fetch Claude status: ${response.status} ${response.statusText}`) };
		}

		const data: unknown = await response.json();

		// Validate response data
		const validatedData = v.parse(claudeStatusSchema, data);
		return { success: true, value: validatedData };
	}
	catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		return { success: false, error: err };
	}
}
