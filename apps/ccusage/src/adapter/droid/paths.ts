import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const DROID_SESSIONS_DIR_ENV = 'DROID_SESSIONS_DIR';
const DEFAULT_DROID_SESSIONS_DIR = path.join(os.homedir(), '.factory', 'sessions');

function isDroidSettingsFile(filePath: string): boolean {
	return path.basename(filePath).endsWith('.settings.json');
}

export function getDroidSessionPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[DROID_SESSIONS_DIR_ENV], [DEFAULT_DROID_SESSIONS_DIR]),
	);
}

export function getDroidSessionPath(): string | null {
	return getDroidSessionPaths()[0] ?? null;
}

export async function discoverDroidSettingsFiles(): Promise<string[]> {
	const files = await Promise.all(
		getDroidSessionPaths().map(async (sessionPath) =>
			collectFilesRecursive(sessionPath, { extension: '.json' }),
		),
	);
	return files.flat().filter(isDroidSettingsFile);
}

export async function detectDroidSettingsFiles(): Promise<boolean> {
	return (await discoverDroidSettingsFiles()).length > 0;
}

if (import.meta.vitest != null) {
	describe('droid path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses DROID_SESSIONS_DIR when it points to an existing directory', async () => {
			await using fixture = await createFixture({});
			vi.stubEnv(DROID_SESSIONS_DIR_ENV, fixture.path);

			expect(getDroidSessionPath()).toBe(path.resolve(fixture.path));
		});

		it('returns no path for a missing DROID_SESSIONS_DIR', () => {
			vi.stubEnv(DROID_SESSIONS_DIR_ENV, '/path/that/does/not/exist');

			expect(getDroidSessionPath()).toBeNull();
		});

		it('returns directories for comma-separated DROID_SESSIONS_DIR entries', async () => {
			await using fixture1 = await createFixture({});
			await using fixture2 = await createFixture({});
			vi.stubEnv(DROID_SESSIONS_DIR_ENV, `${fixture1.path}, ,${fixture2.path},`);

			expect(getDroidSessionPaths()).toEqual([
				path.resolve(fixture1.path),
				path.resolve(fixture2.path),
			]);
		});

		it('discovers only Droid settings JSON files', async () => {
			await using fixture = await createFixture({
				'a.settings.json': '{}',
				'a.jsonl': '{}',
				'ignore.json': '{}',
				nested: {
					'b.settings.json': '{}',
				},
			});
			vi.stubEnv(DROID_SESSIONS_DIR_ENV, fixture.path);

			await expect(discoverDroidSettingsFiles()).resolves.toEqual([
				fixture.getPath('a.settings.json'),
				fixture.getPath('nested/b.settings.json'),
			]);
		});
	});
}
