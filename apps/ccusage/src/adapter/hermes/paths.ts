import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const HERMES_HOME_ENV = 'HERMES_HOME';
const DEFAULT_HERMES_HOME = path.join(homedir(), '.hermes');
const HERMES_STATE_DB_FILE = 'state.db';

export function getHermesStateDbPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[HERMES_HOME_ENV], [DEFAULT_HERMES_HOME]),
	)
		.map((home) => path.join(home, HERMES_STATE_DB_FILE))
		.filter((dbPath) => existsSync(dbPath));
}

export function detectHermesStateDb(): boolean {
	return getHermesStateDbPaths().length > 0;
}

if (import.meta.vitest != null) {
	describe('Hermes Agent path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses HERMES_HOME/state.db when it exists', async () => {
			await using fixture = await createFixture({
				'state.db': '',
			});
			vi.stubEnv(HERMES_HOME_ENV, fixture.path);

			expect(getHermesStateDbPaths()).toEqual([fixture.getPath('state.db')]);
			expect(detectHermesStateDb()).toBe(true);
		});
	});
}
