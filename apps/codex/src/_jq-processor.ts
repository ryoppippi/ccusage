import { Result } from '@praha/byethrow';
import spawn from 'nano-spawn';

export async function processWithJq(jsonData: unknown, jqCommand: string): Result.ResultAsync<string, Error> {
	const jsonString = JSON.stringify(jsonData);

	const result = Result.try({
		try: async () => {
			const spawnResult = await spawn('jq', [jqCommand], {
				stdin: { string: jsonString },
			});
			return spawnResult.output.trim();
		},
		catch: (error: unknown) => {
			if (error instanceof Error) {
				if (error.message.includes('ENOENT') || error.message.includes('not found')) {
					return new Error('jq command not found. Please install jq to use the --jq option.');
				}
				return new Error(`jq processing failed: ${error.message}`);
			}
			return new Error('Unknown error during jq processing');
		},
	});

	return result();
}

if (import.meta.vitest != null) {
	const ensureJqAvailable = async (result: Awaited<ReturnType<typeof processWithJq>>): Promise<string | null> => {
		if (Result.isFailure(result)) {
			if (result.error.message.includes('jq command not found')) {
				return null;
			}
			throw result.error;
		}
		return result.value;
	};

	describe('processWithJq', () => {
		it('returns jq output when command succeeds', async () => {
			const data = { name: 'codex', value: 7 };
			const result = await processWithJq(data, '.name');
			const output = await ensureJqAvailable(result);
			if (output == null) {
				expect(true).toBe(true);
				return;
			}
			expect(output).toBe('"codex"');
		});

		it('wraps jq errors when the filter is invalid', async () => {
			const data = { message: 'hello' };
			const result = await processWithJq(data, 'invalid {');
			if (Result.isFailure(result)) {
				if (result.error.message.includes('jq command not found')) {
					expect(result.error.message).toContain('jq');
					return;
				}
				expect(result.error.message).toContain('jq processing failed');
			}
			else {
				expect.fail('Expected jq to report an error for invalid syntax');
			}
		});

		it('provides a helpful error when jq is missing', async () => {
			const result = await processWithJq({ value: 1 }, '.');
			if (Result.isFailure(result)) {
				expect(result.error.message).toContain('jq command not found');
			}
			else {
				expect(result.value.length).toBeGreaterThan(0);
			}
		});
	});
}
