import { Result } from '@praha/byethrow';
import spawn from 'nano-spawn';

/**
 * Process JSON data with a jq command
 * @param jsonData - The JSON data to process
 * @param jqCommand - The jq command/filter to apply
 * @returns The processed output from jq
 */
export async function processWithJq(jsonData: unknown, jqCommand: string): Result.ResultAsync<string, Error> {
	// Convert JSON data to string
	const jsonString = JSON.stringify(jsonData);

	// Use Result.try with object form to wrap spawn call
	const result = Result.try({
		try: async () => {
			const spawnResult = await spawn('jq', [jqCommand], {
				stdin: { string: jsonString },
			});
			return spawnResult.output.trim();
		},
		catch: (error: unknown) => {
			if (error instanceof Error) {
				// Check if jq is not installed
				if (error.message.includes('ENOENT') || error.message.includes('not found')) {
					return new Error('jq command not found. Please install jq to use the --jq option.');
				}
				// Return other errors (e.g., invalid jq syntax)
				return new Error(`jq processing failed: ${error.message}`);
			}
			return new Error('Unknown error during jq processing');
		},
	});

	return result();
}

// In-source tests
if (import.meta.vitest != null) {
	describe('processWithJq', () => {
		it('should process JSON with simple filter', async () => {
			const data = { name: 'test', value: 42 };
			const result = await processWithJq(data, '.name');
			const unwrapped = Result.unwrap(result);
			expect(unwrapped).toBe('"test"');
		});

		it('should process JSON with complex filter', async () => {
			const data = {
				items: [
					{ id: 1, name: 'apple' },
					{ id: 2, name: 'banana' },
				],
			};
			const result = await processWithJq(data, '.items | map(.name)');
			const unwrapped = Result.unwrap(result);
			const parsed = JSON.parse(unwrapped) as string[];
			expect(parsed).toEqual(['apple', 'banana']);
		});

		it('should handle raw output', async () => {
			const data = { message: 'hello world' };
			const result = await processWithJq(data, '.message | @text');
			const unwrapped = Result.unwrap(result);
			expect(unwrapped).toBe('"hello world"');
		});

		it('should return error for invalid jq syntax', async () => {
			const data = { test: 'value' };
			const result = await processWithJq(data, 'invalid syntax {');
			const error = Result.unwrapError(result);
			expect(error.message).toContain('jq processing failed');
		});

		it('should handle complex jq operations', async () => {
			const data = {
				users: [
					{ name: 'Alice', age: 30 },
					{ name: 'Bob', age: 25 },
					{ name: 'Charlie', age: 35 },
				],
			};
			const result = await processWithJq(data, '.users | sort_by(.age) | .[0].name');
			const unwrapped = Result.unwrap(result);
			expect(unwrapped).toBe('"Bob"');
		});

		it('should handle numeric output', async () => {
			const data = { values: [1, 2, 3, 4, 5] };
			const result = await processWithJq(data, '.values | add');
			const unwrapped = Result.unwrap(result);
			expect(unwrapped).toBe('15');
		});
	});
}
