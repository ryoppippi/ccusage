import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';

export const GOOSE_PATH_ROOT_ENV = 'GOOSE_PATH_ROOT';
export const GOOSE_DB_FILE_NAME = 'sessions.db';

function isFileSyncSafe(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function getGooseDefaultDbCandidates(): string[] {
	const home = os.homedir();
	return [
		path.join(home, '.local/share/goose/sessions', GOOSE_DB_FILE_NAME),
		path.join(home, 'Library/Application Support/goose/sessions', GOOSE_DB_FILE_NAME),
		path.join(home, '.local/share/Block/goose/sessions', GOOSE_DB_FILE_NAME),
	];
}

export function getGooseDbPathFromRoot(root: string): string {
	return path.join(root, 'data/sessions', GOOSE_DB_FILE_NAME);
}

export function getGooseDbPaths(): string[] {
	const envRoot = process.env[GOOSE_PATH_ROOT_ENV]?.trim();
	const candidates =
		envRoot == null || envRoot === ''
			? getGooseDefaultDbCandidates()
			: [getGooseDbPathFromRoot(envRoot)];
	return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate)))).filter(
		isFileSyncSafe,
	);
}

export function hasGooseDatabase(): boolean {
	return getGooseDbPaths().some((dbPath) => existsSync(dbPath));
}

if (import.meta.vitest != null) {
	describe('Goose path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses GOOSE_PATH_ROOT/data/sessions/sessions.db when present', async () => {
			await using fixture = await createFixture({
				data: {
					sessions: {
						[GOOSE_DB_FILE_NAME]: '',
					},
				},
			});
			vi.stubEnv(GOOSE_PATH_ROOT_ENV, fixture.path);

			expect(getGooseDbPaths()).toEqual([
				path.resolve(fixture.getPath('data/sessions', GOOSE_DB_FILE_NAME)),
			]);
		});

		it('returns no paths for a missing GOOSE_PATH_ROOT database', async () => {
			await using fixture = await createFixture({});
			vi.stubEnv(GOOSE_PATH_ROOT_ENV, fixture.path);

			expect(getGooseDbPaths()).toEqual([]);
		});
	});
}
