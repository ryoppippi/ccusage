import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { hasFileRecursive } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { normalizePathList } from '../path-list.ts';

export const CODEX_HOME_ENV = 'CODEX_HOME';
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_SESSION_SUBDIR = 'sessions';

export type CodexSessionSource = {
	homePath: string;
	sessionsPath: string;
	sourceRoot?: string;
};

export function getCodexHomePaths(): string[] {
	return normalizePathList(process.env[CODEX_HOME_ENV], [DEFAULT_CODEX_DIR]);
}

function buildCodexSourceRootLabels(homePaths: readonly string[]): Map<string, string> {
	if (homePaths.length < 2) {
		return new Map();
	}

	const basenameCounts = new Map<string, number>();
	for (const homePath of homePaths) {
		const resolvedBasename = path.basename(homePath);
		const basename = resolvedBasename === '' ? homePath : resolvedBasename;
		basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
	}

	return new Map(
		homePaths.map((homePath) => {
			const resolvedBasename = path.basename(homePath);
			const basename = resolvedBasename === '' ? homePath : resolvedBasename;
			const label = (basenameCounts.get(basename) ?? 0) > 1 ? homePath : basename;
			return [homePath, label];
		}),
	);
}

export function getCodexSessionSources(): CodexSessionSource[] {
	const homePaths = getCodexHomePaths();
	const sourceRootLabels = buildCodexSourceRootLabels(homePaths);
	return homePaths.map((homePath) => ({
		homePath,
		sessionsPath: path.join(homePath, DEFAULT_SESSION_SUBDIR),
		sourceRoot: sourceRootLabels.get(homePath),
	}));
}

export function getCodexSessionsPaths(): string[] {
	return getCodexSessionSources().map((source) => source.sessionsPath);
}

export function getCodexSessionsPath(): string {
	return getCodexSessionsPaths()[0]!;
}

export async function detectCodex(): Promise<boolean> {
	const results = await Promise.all(
		getCodexSessionsPaths().map(async (sessionsPath) =>
			hasFileRecursive(sessionsPath, { extension: '.jsonl' }),
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

		it('labels multiple CODEX_HOME entries for source-aware session reports', async () => {
			await using fixture1 = await createFixture({
				sessions: {},
			});
			await using fixture2 = await createFixture({
				sessions: {},
			});
			vi.stubEnv(CODEX_HOME_ENV, `${fixture1.path},${fixture2.path}`);

			expect(getCodexSessionSources()).toEqual([
				{
					homePath: path.resolve(fixture1.path),
					sessionsPath: fixture1.getPath('sessions'),
					sourceRoot: path.basename(fixture1.path),
				},
				{
					homePath: path.resolve(fixture2.path),
					sessionsPath: fixture2.getPath('sessions'),
					sourceRoot: path.basename(fixture2.path),
				},
			]);
		});
	});
}
