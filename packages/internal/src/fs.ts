import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createFixture } from 'fs-fixture';
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
		} catch {
			return;
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
}
