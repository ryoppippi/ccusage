import { stat, utimes, writeFile } from 'node:fs/promises';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';

export function unreachable(value: never): never {
	throw new Error(`Unreachable code reached with value: ${value as any}`);
}

/**
 * Gets the last modified time of a file using Result pattern
 * @param filePath - Path to the file
 * @returns Modification time in milliseconds, or 0 if file doesn't exist
 */
export async function getFileModifiedTime(filePath: string): Promise<number> {
	return Result.pipe(
		Result.try({
			try: stat(filePath),
			catch: error => error,
		}),
		Result.map(stats => stats.mtime.getTime()),
		Result.unwrap(0), // Default to 0 if file doesn't exist or can't be accessed
	);
}

if (import.meta.vitest != null) {
	describe('unreachable', () => {
		it('should throw an error when called', () => {
			expect(() => unreachable('test' as never)).toThrow(
				'Unreachable code reached with value: test',
			);
		});
	});

	describe('getFileModifiedTime', () => {
		it('returns specific modification time when set', async () => {
			await using fixture = await createFixture({
				'test.txt': 'content',
			});

			// Set specific time (2024-01-01 12:00:00 UTC)
			const specificTime = new Date('2024-01-01T12:00:00.000Z');
			await utimes(`${fixture.path}/test.txt`, specificTime, specificTime);

			const mtime = await getFileModifiedTime(fixture.getPath('test.txt'));
			expect(mtime).toBe(specificTime.getTime());
			expect(typeof mtime).toBe('number');
		});

		it('returns 0 for non-existent file', async () => {
			const mtime = await getFileModifiedTime('/non/existent/file.txt');
			expect(mtime).toBe(0);
		});

		it('detects file modification correctly', async () => {
			await using fixture = await createFixture({
				'test.txt': 'content',
			});

			// Set first time
			const firstTime = new Date('2024-01-01T10:00:00.000Z');
			await utimes(`${fixture.path}/test.txt`, firstTime, firstTime);

			const mtime1 = await getFileModifiedTime(`${fixture.path}/test.txt`);
			expect(mtime1).toBe(firstTime.getTime());

			// Modify file and set second time
			const secondTime = new Date('2024-01-01T11:00:00.000Z');
			await writeFile(fixture.getPath('test.txt'), 'modified content');
			await utimes(fixture.getPath('test.txt'), secondTime, secondTime);

			const mtime2 = await getFileModifiedTime(fixture.getPath('test.txt'));
			expect(mtime2).toBe(secondTime.getTime());
			expect(mtime2).toBeGreaterThan(mtime1);
		});
	});
}
