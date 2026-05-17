import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { hasFileRecursive } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { normalizePathList } from '../path-list.ts';

export const CODEX_HOME_ENV = 'CODEX_HOME';
export const CODEX_EXEC_LOG_DIR_ENV = 'CODEX_EXEC_LOG_DIR';
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_SESSION_SUBDIR = 'sessions';

export function getCodexHomePaths(): string[] {
	return normalizePathList(process.env[CODEX_HOME_ENV], [DEFAULT_CODEX_DIR]);
}

export function getCodexSessionsPaths(): string[] {
	return getCodexHomePaths().map((codexHome) => path.join(codexHome, DEFAULT_SESSION_SUBDIR));
}

export function getCodexExecLogPaths(): string[] {
	return normalizePathList(process.env[CODEX_EXEC_LOG_DIR_ENV], []);
}

export function getCodexUsagePaths(): string[] {
	return [...getCodexSessionsPaths(), ...getCodexExecLogPaths()];
}

export function getCodexSessionsPath(): string {
	return getCodexSessionsPaths()[0]!;
}

export async function detectCodex(): Promise<boolean> {
	const results = await Promise.all(
		getCodexUsagePaths().map(async (usagePath) =>
			hasFileRecursive(usagePath, { extension: '.jsonl' }),
		),
	);
	return results.some(Boolean);
}

if (import.meta.vitest != null) {
	describe('Codex path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses CODEX_HOME sessions when CODEX_HOME points to an existing Codex directory', async () => {
			await using fixture = await createFixture({
				sessions: {
					nested: {
						'session.jsonl': '{}',
					},
				},
			});
			vi.stubEnv(CODEX_HOME_ENV, fixture.path);

			expect(getCodexSessionsPath()).toBe(fixture.getPath('sessions'));
			await expect(detectCodex()).resolves.toBe(true);
		});

		it('stops Codex detection with false for missing sessions directories', async () => {
			await using fixture = await createFixture({});
			vi.stubEnv(CODEX_HOME_ENV, fixture.path);

			await expect(detectCodex()).resolves.toBe(false);
		});

		it('returns session directories for comma-separated CODEX_HOME entries', async () => {
			await using fixture1 = await createFixture({
				sessions: {},
			});
			await using fixture2 = await createFixture({
				sessions: {},
			});
			vi.stubEnv(CODEX_HOME_ENV, `${fixture1.path}, ,${fixture2.path},`);

			expect(getCodexSessionsPaths()).toEqual([
				fixture1.getPath('sessions'),
				fixture2.getPath('sessions'),
			]);
		});

		it('uses CODEX_EXEC_LOG_DIR for saved codex exec JSONL files', async () => {
			await using fixture = await createFixture({
				exec: {
					'run.jsonl': '{}',
				},
			});
			vi.stubEnv(CODEX_HOME_ENV, fixture.getPath('missing'));
			vi.stubEnv(CODEX_EXEC_LOG_DIR_ENV, fixture.getPath('exec'));

			expect(getCodexExecLogPaths()).toEqual([fixture.getPath('exec')]);
			expect(getCodexUsagePaths()).toEqual([
				fixture.getPath('missing', 'sessions'),
				fixture.getPath('exec'),
			]);
			await expect(detectCodex()).resolves.toBe(true);
		});
	});
}
