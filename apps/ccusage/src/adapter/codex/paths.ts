import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
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

async function hasCodexSessionFile(directoryPath: string): Promise<boolean> {
	const entriesResult = await Result.try({
		try: readdir(directoryPath, { withFileTypes: true }),
		catch: (error) => error,
	});
	if (Result.isFailure(entriesResult)) {
		return false;
	}

	for (const entry of entriesResult.value) {
		const entryPath = path.join(directoryPath, entry.name);
		if (entry.isFile() && entry.name.endsWith('.jsonl')) {
			return true;
		}
		if (entry.isDirectory() && (await hasCodexSessionFile(entryPath))) {
			return true;
		}
	}
	return false;
}

export async function detectCodex(): Promise<boolean> {
	return hasCodexSessionFile(getCodexSessionsPath());
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
