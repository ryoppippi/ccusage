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

export async function readTextFile(filePath: string): Promise<string> {
	const bun = getBunRuntime();
	if (bun != null) {
		return bun.file(filePath).text();
	}
	return readFile(filePath, 'utf8');
}

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
