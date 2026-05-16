import { Buffer } from 'node:buffer';
import { statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createFixture } from 'fs-fixture';
import { compareStrings } from './sort.ts';

export type CollectFilesOptions = {
	extension?: `.${string}`;
};

type BunFileLike = {
	size: number;
	bytes?: () => Promise<Uint8Array>;
	text: () => Promise<string>;
};

type BunRuntimeLike = {
	file: (path: string) => BunFileLike;
};

export type ReadBufferedTextFileOptions = {
	maxBufferedBytes: number;
};

function getBunRuntime(): BunRuntimeLike | null {
	const runtime = (globalThis as { Bun?: Partial<BunRuntimeLike> }).Bun;
	return typeof runtime?.file === 'function' ? (runtime as BunRuntimeLike) : null;
}

/**
 * Reads a UTF-8 text file, using Bun.file when the Bun runtime is available.
 *
 * @param filePath - File path to read.
 * @returns File contents.
 */
export async function readTextFile(filePath: string): Promise<string> {
	const bun = getBunRuntime();
	if (bun != null) {
		return bun.file(filePath).text();
	}
	return readFile(filePath, 'utf8');
}

/**
 * Reads a UTF-8 text file when it fits within the configured buffer limit.
 *
 * @param filePath - File path to read.
 * @param options - Buffer limit options.
 * @returns File contents, or null when the file is larger than maxBufferedBytes.
 */
export async function readBufferedTextFile(
	filePath: string,
	options: ReadBufferedTextFileOptions,
): Promise<string | null> {
	const bun = getBunRuntime();
	if (bun != null) {
		const file = bun.file(filePath);
		return file.size <= options.maxBufferedBytes ? file.text() : null;
	}

	const stats = await stat(filePath);
	return stats.size <= options.maxBufferedBytes ? readFile(filePath, 'utf8') : null;
}

export async function readBufferedBytesFile(
	filePath: string,
	options: ReadBufferedTextFileOptions,
): Promise<Uint8Array | null> {
	const bun = getBunRuntime();
	if (bun != null) {
		const file = bun.file(filePath);
		if (typeof file.bytes === 'function') {
			return file.size <= options.maxBufferedBytes ? file.bytes() : null;
		}
	}

	const stats = await stat(filePath);
	return stats.size <= options.maxBufferedBytes ? readFile(filePath) : null;
}

export async function collectFilesRecursive(
	root: string,
	options: CollectFilesOptions = {},
): Promise<string[]> {
	const files: string[] = [];
	const walkDirectory = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			const code =
				typeof error === 'object' && error != null && 'code' in error
					? (error as { code?: string }).code
					: undefined;
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
				return;
			}
			throw error;
		}

		const childWalks: Array<Promise<void>> = [];
		for (const entry of entries) {
			const filePath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				childWalks.push(walkDirectory(filePath));
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (options.extension != null && !entry.name.endsWith(options.extension)) {
				continue;
			}
			files.push(filePath);
		}

		await Promise.all(childWalks);
	};

	await walkDirectory(root);
	return files.sort(compareStrings);
}

/**
 * Checks whether a directory tree contains at least one matching file.
 *
 * @param root - Directory to search.
 * @param options - Optional file extension filter.
 * @returns True when a matching file is found; false for missing, inaccessible, or non-directory paths.
 */
export async function hasFileRecursive(
	root: string,
	options: CollectFilesOptions = {},
): Promise<boolean> {
	const walkDirectory = async (directory: string): Promise<boolean> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			const code =
				typeof error === 'object' && error != null && 'code' in error
					? (error as { code?: string }).code
					: undefined;
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
				return false;
			}
			throw error;
		}

		for (const entry of entries) {
			const filePath = path.join(directory, entry.name);
			if (entry.isDirectory() && (await walkDirectory(filePath))) {
				return true;
			}
			if (entry.isFile() && (options.extension == null || entry.name.endsWith(options.extension))) {
				return true;
			}
		}
		return false;
	};

	return walkDirectory(root);
}

/**
 * Returns true only when pathname exists and is a directory.
 *
 * Files, missing paths, and stat errors return false.
 */
export function isDirectorySyncSafe(pathname: string): boolean {
	try {
		return statSync(pathname).isDirectory();
	} catch {
		return false;
	}
}

if (import.meta.vitest != null) {
	describe('readTextFile', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('reads text through Bun.file when Bun is available', async () => {
			const textCalls: string[] = [];
			vi.stubGlobal('Bun', {
				file: (filePath: string) => ({
					size: 4,
					text: async () => {
						textCalls.push(filePath);
						return 'fast';
					},
				}),
			});

			await expect(readTextFile('/tmp/example.txt')).resolves.toBe('fast');
			expect(textCalls).toEqual(['/tmp/example.txt']);
		});

		it('reads text from node fs when Bun is unavailable', async () => {
			vi.stubGlobal('Bun', undefined);
			await using fixture = await createFixture({
				'file.txt': 'fallback',
			});

			await expect(readTextFile(fixture.getPath('file.txt'))).resolves.toBe('fallback');
		});
	});

	describe('readBufferedTextFile', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('returns null when a Bun file is larger than the buffered limit', async () => {
			vi.stubGlobal('Bun', {
				file: () => ({
					size: 5,
					text: async () => 'large',
				}),
			});

			await expect(readBufferedTextFile('/tmp/large.txt', { maxBufferedBytes: 4 })).resolves.toBe(
				null,
			);
		});
	});

	describe('readBufferedBytesFile', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('reads bytes through Bun.file when the file fits in the buffered limit', async () => {
			const byteCalls: string[] = [];
			vi.stubGlobal('Bun', {
				file: (filePath: string) => ({
					size: 3,
					bytes: async () => {
						byteCalls.push(filePath);
						return new Uint8Array([1, 2, 3]);
					},
					text: async () => '',
				}),
			});

			const bytes = await readBufferedBytesFile('/tmp/example.jsonl', { maxBufferedBytes: 3 });

			expect(Array.from(bytes ?? [])).toEqual([1, 2, 3]);
			expect(byteCalls).toEqual(['/tmp/example.jsonl']);
		});

		it('reads bytes from node fs when Bun is unavailable', async () => {
			vi.stubGlobal('Bun', undefined);
			await using fixture = await createFixture({
				'usage.jsonl': 'abc',
			});

			const bytes = await readBufferedBytesFile(fixture.getPath('usage.jsonl'), {
				maxBufferedBytes: 3,
			});

			expect(Buffer.from(bytes ?? []).toString('utf8')).toBe('abc');
		});
	});

	describe('collectFilesRecursive', () => {
		it('collects matching files recursively in stable order', async () => {
			await using fixture = await createFixture({
				'a.jsonl': '{}',
				nested: {
					'b.jsonl': '{}',
					'ignore.txt': 'nope',
				},
				z: {
					'c.jsonl': '{}',
				},
			});

			const files = await collectFilesRecursive(fixture.path, { extension: '.jsonl' });

			expect(files.map((file) => path.relative(fixture.path, file))).toEqual([
				'a.jsonl',
				path.join('nested', 'b.jsonl'),
				path.join('z', 'c.jsonl'),
			]);
		});

		it('returns an empty list for unreadable or missing directories', async () => {
			const files = await collectFilesRecursive('/path/that/does/not/exist', {
				extension: '.json',
			});

			expect(files).toEqual([]);
		});
	});

	describe('hasFileRecursive', () => {
		it('returns true when a matching file exists recursively', async () => {
			await using fixture = await createFixture({
				nested: {
					'usage.jsonl': '{}',
				},
			});

			await expect(hasFileRecursive(fixture.path, { extension: '.jsonl' })).resolves.toBe(true);
		});

		it('returns false for missing or unmatched directories', async () => {
			await using fixture = await createFixture({
				'usage.txt': '{}',
			});

			await expect(hasFileRecursive(fixture.path, { extension: '.jsonl' })).resolves.toBe(false);
			await expect(
				hasFileRecursive('/path/that/does/not/exist', { extension: '.jsonl' }),
			).resolves.toBe(false);
		});
	});

	describe('isDirectorySyncSafe', () => {
		it('returns true for directories and false for files or missing paths', async () => {
			await using fixture = await createFixture({
				'file.txt': 'file',
			});

			expect(isDirectorySyncSafe(fixture.path)).toBe(true);
			expect(isDirectorySyncSafe(fixture.getPath('file.txt'))).toBe(false);
			expect(isDirectorySyncSafe(fixture.getPath('missing'))).toBe(false);
		});
	});
}
