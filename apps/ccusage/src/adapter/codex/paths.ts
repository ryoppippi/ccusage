import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { hasFileRecursive } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';

export const CODEX_HOME_ENV = 'CODEX_HOME';
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_SESSION_SUBDIR = 'sessions';

export function getCodexSessionsPath(): string {
	const codexHome = process.env[CODEX_HOME_ENV]?.trim();
	return path.join(
		codexHome == null || codexHome === '' ? DEFAULT_CODEX_DIR : path.resolve(codexHome),
		DEFAULT_SESSION_SUBDIR,
	);
}

export async function detectCodex(): Promise<boolean> {
	return hasFileRecursive(getCodexSessionsPath(), { extension: '.jsonl' });
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
	});
}
