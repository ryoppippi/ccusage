import path from 'node:path';
import process from 'node:process';
import { isDirectorySyncSafe } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { USER_HOME_DIR } from '../../consts.ts';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const OPENCLAW_DIR_ENV = 'OPENCLAW_DIR';

const OPENCLAW_DEFAULT_DIRS = [
	path.join(USER_HOME_DIR, '.openclaw'),
	path.join(USER_HOME_DIR, '.clawdbot'),
	path.join(USER_HOME_DIR, '.moltbot'),
	path.join(USER_HOME_DIR, '.moldbot'),
];

export function getOpenClawPaths(customPath?: string): string[] {
	if (customPath != null && customPath.trim() !== '') {
		return getExistingDirectories(normalizePathList(customPath, []));
	}

	const envValue = process.env[OPENCLAW_DIR_ENV];
	if (envValue != null && envValue.trim() !== '') {
		return getExistingDirectories(normalizePathList(envValue, []));
	}

	return OPENCLAW_DEFAULT_DIRS.filter((dir) => isDirectorySyncSafe(dir));
}

if (import.meta.vitest != null) {
	describe('getOpenClawPaths', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('returns explicit existing directories from comma-separated input', async () => {
			await using fixture1 = await createFixture({ agents: {} });
			await using fixture2 = await createFixture({ agents: {} });

			expect(getOpenClawPaths(`${fixture1.path}, ,${fixture2.path},`)).toEqual([
				path.resolve(fixture1.path),
				path.resolve(fixture2.path),
			]);
		});

		it('returns no paths when explicit directory is missing', () => {
			expect(getOpenClawPaths('/path/that/does/not/exist')).toEqual([]);
		});

		it('uses OPENCLAW_DIR when no explicit path is provided', async () => {
			await using fixture = await createFixture({ agents: {} });
			vi.stubEnv(OPENCLAW_DIR_ENV, fixture.path);

			expect(getOpenClawPaths()).toEqual([path.resolve(fixture.path)]);
		});

		it('ignores a missing OPENCLAW_DIR', () => {
			vi.stubEnv(OPENCLAW_DIR_ENV, '/path/that/does/not/exist');

			expect(getOpenClawPaths()).toEqual([]);
		});
	});
}
