import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, hasFileRecursive } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const AMP_DATA_DIR_ENV = 'AMP_DATA_DIR';
export const AMP_THREADS_DIR_NAME = 'threads';
const DEFAULT_AMP_DIR = path.join(os.homedir(), '.local/share/amp');

export function getAmpPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[AMP_DATA_DIR_ENV], [DEFAULT_AMP_DIR]),
	);
}

export function getAmpPath(): string | null {
	return getAmpPaths()[0] ?? null;
}

export async function discoverAmpThreadFiles(): Promise<string[]> {
	const files = await Promise.all(
		getAmpPaths().map(async (ampPath) =>
			collectFilesRecursive(path.join(ampPath, AMP_THREADS_DIR_NAME), { extension: '.json' }),
		),
	);
	return files.flat();
}

export async function detectAmpThreadFiles(): Promise<boolean> {
	const results = await Promise.all(
		getAmpPaths().map(async (ampPath) =>
			hasFileRecursive(path.join(ampPath, AMP_THREADS_DIR_NAME), { extension: '.json' }),
		),
	);
	return results.some(Boolean);
}

if (import.meta.vitest != null) {
	describe('amp path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses AMP_DATA_DIR when it points to an existing directory', async () => {
			await using fixture = await createFixture({
				threads: {},
			});
			vi.stubEnv(AMP_DATA_DIR_ENV, fixture.path);

			expect(getAmpPath()).toBe(path.resolve(fixture.path));
		});

		it('returns no path for a missing AMP_DATA_DIR', () => {
			vi.stubEnv(AMP_DATA_DIR_ENV, '/path/that/does/not/exist');

			expect(getAmpPath()).toBeNull();
		});

		it('returns directories for comma-separated AMP_DATA_DIR entries', async () => {
			await using fixture1 = await createFixture({
				threads: {},
			});
			await using fixture2 = await createFixture({
				threads: {},
			});
			vi.stubEnv(AMP_DATA_DIR_ENV, `${fixture1.path}, ,${fixture2.path},`);

			expect(getAmpPaths()).toEqual([path.resolve(fixture1.path), path.resolve(fixture2.path)]);
		});

		it('discovers thread JSON files under the Amp data directory', async () => {
			await using fixture = await createFixture({
				threads: {
					'a.json': '{}',
					'ignore.txt': 'no',
				},
			});
			vi.stubEnv(AMP_DATA_DIR_ENV, fixture.path);

			await expect(discoverAmpThreadFiles()).resolves.toEqual([fixture.getPath('threads/a.json')]);
		});
	});
}
