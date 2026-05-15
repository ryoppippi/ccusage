import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareStrings } from './sort.ts';

export type CollectFilesOptions = {
	extension?: `.${string}`;
};

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

if (import.meta.vitest != null) {
	describe('collectFilesRecursive', () => {
		it('collects matching files recursively in stable order', async () => {
			const directory = await mkdtemp(path.join(tmpdir(), 'ccusage-fs-'));
			try {
				await mkdir(path.join(directory, 'nested'), { recursive: true });
				await mkdir(path.join(directory, 'z'), { recursive: true });
				await writeFile(path.join(directory, 'a.jsonl'), '{}');
				await writeFile(path.join(directory, 'nested', 'b.jsonl'), '{}');
				await writeFile(path.join(directory, 'nested', 'ignore.txt'), 'nope');
				await writeFile(path.join(directory, 'z', 'c.jsonl'), '{}');

				const files = await collectFilesRecursive(directory, { extension: '.jsonl' });

				expect(files.map((file) => path.relative(directory, file))).toEqual([
					'a.jsonl',
					path.join('nested', 'b.jsonl'),
					path.join('z', 'c.jsonl'),
				]);
			} finally {
				await rm(directory, { force: true, recursive: true });
			}
		});

		it('returns an empty list for unreadable or missing directories', async () => {
			const files = await collectFilesRecursive('/path/that/does/not/exist', {
				extension: '.json',
			});

			expect(files).toEqual([]);
		});
	});
}
