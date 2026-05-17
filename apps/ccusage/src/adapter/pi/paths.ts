import path from 'node:path';
import process from 'node:process';
import { isDirectorySyncSafe } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { USER_HOME_DIR } from '../../consts.ts';

export const PI_AGENT_DIR_ENV = 'PI_AGENT_DIR';
const PI_AGENT_SESSIONS_DIR_NAME = 'sessions';
const DEFAULT_PI_AGENT_PATH = path.join('.pi', 'agent');

export function getPiAgentPaths(customPath?: string): string[] {
	if (customPath != null && customPath.trim() !== '') {
		const resolved = path.resolve(customPath);
		return isDirectorySyncSafe(resolved) ? [resolved] : [];
	}

	const envPath = (process.env[PI_AGENT_DIR_ENV] ?? '').trim();
	if (envPath !== '') {
		const resolved = path.resolve(envPath);
		return isDirectorySyncSafe(resolved) ? [resolved] : [];
	}

	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_PI_AGENT_PATH, PI_AGENT_SESSIONS_DIR_NAME);
	return isDirectorySyncSafe(defaultPath) ? [defaultPath] : [];
}

if (import.meta.vitest != null) {
	describe('getPiAgentPaths', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('returns an explicit existing sessions directory', async () => {
			await using fixture = await createFixture({
				sessions: {},
			});

			expect(getPiAgentPaths(fixture.getPath('sessions'))).toEqual([fixture.getPath('sessions')]);
		});

		it('returns no paths for an explicit missing directory', () => {
			expect(getPiAgentPaths('/path/that/does/not/exist')).toEqual([]);
		});

		it('uses PI_AGENT_DIR when no explicit path is provided', async () => {
			await using fixture = await createFixture({
				sessions: {},
			});
			vi.stubEnv(PI_AGENT_DIR_ENV, fixture.getPath('sessions'));

			expect(getPiAgentPaths()).toEqual([fixture.getPath('sessions')]);
		});

		it('ignores a missing PI_AGENT_DIR', () => {
			vi.stubEnv(PI_AGENT_DIR_ENV, '/path/that/does/not/exist');

			expect(getPiAgentPaths()).toEqual([]);
		});
	});
}
