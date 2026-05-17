import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

const DEFAULT_KILO_PATH = path.join(homedir(), '.local/share/kilo');
export const KILO_DATA_DIR_ENV = 'KILO_DATA_DIR';
export const KILO_DB_FILE_NAME = 'kilo.db';

export function getKiloPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[KILO_DATA_DIR_ENV], [DEFAULT_KILO_PATH]),
	);
}

export function getKiloDbPath(kiloPath: string): string | null {
	const dbPath = path.join(kiloPath, KILO_DB_FILE_NAME);
	return existsSync(dbPath) ? dbPath : null;
}

export function hasKiloDatabase(kiloPath: string): boolean {
	return getKiloDbPath(kiloPath) != null;
}

export function detectKiloSources(kiloPath: string): boolean {
	return hasKiloDatabase(kiloPath);
}

if (import.meta.vitest != null) {
	describe('Kilo path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses KILO_DATA_DIR when it points to an existing directory', async () => {
			await using fixture = await createFixture({
				'kilo.db': '',
			});
			vi.stubEnv(KILO_DATA_DIR_ENV, fixture.path);

			expect(getKiloPaths()).toEqual([path.resolve(fixture.path)]);
			expect(getKiloDbPath(fixture.path)).toBe(fixture.getPath('kilo.db'));
		});

		it('returns directories for comma-separated KILO_DATA_DIR entries', async () => {
			await using fixture1 = await createFixture({});
			await using fixture2 = await createFixture({});
			vi.stubEnv(KILO_DATA_DIR_ENV, `${fixture1.path}, ,${fixture2.path},`);

			expect(getKiloPaths()).toEqual([path.resolve(fixture1.path), path.resolve(fixture2.path)]);
		});

		it('does not detect a missing Kilo database', async () => {
			await using fixture = await createFixture({});
			vi.stubEnv(KILO_DATA_DIR_ENV, fixture.path);

			expect(detectKiloSources(fixture.path)).toBe(false);
		});
	});
}
