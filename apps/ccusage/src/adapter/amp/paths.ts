import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, hasFileRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';

export const AMP_DATA_DIR_ENV = 'AMP_DATA_DIR';
export const AMP_THREADS_DIR_NAME = 'threads';
const DEFAULT_AMP_DIR = path.join(os.homedir(), '.local/share/amp');

export function getAmpPath(): string | null {
	const envPath = process.env[AMP_DATA_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		return isDirectorySyncSafe(normalizedPath) ? normalizedPath : null;
	}

	return isDirectorySyncSafe(DEFAULT_AMP_DIR) ? DEFAULT_AMP_DIR : null;
}

export async function discoverAmpThreadFiles(): Promise<string[]> {
	const ampPath = getAmpPath();
	if (ampPath == null) {
		return [];
	}
	return collectFilesRecursive(path.join(ampPath, AMP_THREADS_DIR_NAME), { extension: '.json' });
}

export async function detectAmpThreadFiles(): Promise<boolean> {
	const ampPath = getAmpPath();
	return ampPath == null
		? false
		: hasFileRecursive(path.join(ampPath, AMP_THREADS_DIR_NAME), { extension: '.json' });
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
