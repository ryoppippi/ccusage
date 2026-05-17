import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, hasFileRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { logger } from '../../logger.ts';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

const DEFAULT_OPENCODE_PATH = path.join(homedir(), '.local/share/opencode');
export const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';
export const OPENCODE_DB_FILE_NAME = 'opencode.db';
export const OPENCODE_STORAGE_DIR_NAME = 'storage';
export const OPENCODE_MESSAGES_DIR_NAME = 'message';
const OPENCODE_CHANNEL_DB_PATTERN = /^opencode-[\w-]+\.db$/u;

export function getOpenCodePaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[OPENCODE_CONFIG_DIR_ENV], [DEFAULT_OPENCODE_PATH]),
	);
}

export function getOpenCodePath(): string | null {
	return getOpenCodePaths()[0] ?? null;
}

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
	const relativePath = path.relative(directoryPath, targetPath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveOpenCodeDbCandidate(dbPath: string, resolvedOpenCodePath: string): string | null {
	const result = Result.try({
		try: () => realpathSync(dbPath),
		catch: (error) => error,
	})();
	if (Result.isFailure(result) || !isPathInsideDirectory(result.value, resolvedOpenCodePath)) {
		return null;
	}
	return result.value;
}

export function getOpenCodeDbPath(openCodePath: string): string | null {
	const resolvedPath = Result.try({
		try: () => realpathSync(openCodePath),
		catch: (error) => error,
	})();
	if (Result.isFailure(resolvedPath)) {
		logger.warn('Failed to resolve OpenCode data directory:', resolvedPath.error);
		return null;
	}

	const defaultDbPath = path.join(openCodePath, OPENCODE_DB_FILE_NAME);
	if (existsSync(defaultDbPath)) {
		const resolvedDefaultDbPath = resolveOpenCodeDbCandidate(defaultDbPath, resolvedPath.value);
		if (resolvedDefaultDbPath != null) {
			return resolvedDefaultDbPath;
		}
	}

	const entries = Result.try({
		try: () => readdirSync(openCodePath),
		catch: (error) => error,
	})();
	if (Result.isFailure(entries)) {
		logger.warn('Failed to read OpenCode data directory:', entries.error);
		return null;
	}

	for (const entry of entries.value
		.filter((name) => OPENCODE_CHANNEL_DB_PATTERN.test(name))
		.sort()) {
		const resolvedDbPath = resolveOpenCodeDbCandidate(
			path.join(openCodePath, entry),
			resolvedPath.value,
		);
		if (resolvedDbPath != null) {
			return resolvedDbPath;
		}
	}

	return null;
}

export function hasOpenCodeDatabase(openCodePath: string): boolean {
	if (existsSync(path.join(openCodePath, OPENCODE_DB_FILE_NAME))) {
		return true;
	}
	try {
		return readdirSync(openCodePath).some((entry) => OPENCODE_CHANNEL_DB_PATTERN.test(entry));
	} catch {
		return false;
	}
}

export async function discoverOpenCodeMessageFiles(openCodePath: string): Promise<string[]> {
	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);
	if (!isDirectorySyncSafe(messagesDir)) {
		return [];
	}
	return collectFilesRecursive(messagesDir, { extension: '.json' });
}

export async function detectOpenCodeSources(openCodePath: string): Promise<boolean> {
	const messagesDir = path.join(
		openCodePath,
		OPENCODE_STORAGE_DIR_NAME,
		OPENCODE_MESSAGES_DIR_NAME,
	);
	return (
		hasOpenCodeDatabase(openCodePath) ||
		(await hasFileRecursive(messagesDir, { extension: '.json' }))
	);
}

if (import.meta.vitest != null) {
	describe('OpenCode path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses OPENCODE_DATA_DIR when it points to an existing directory', async () => {
			await using fixture = await createFixture({
				storage: {},
			});
			vi.stubEnv(OPENCODE_CONFIG_DIR_ENV, fixture.path);

			expect(getOpenCodePath()).toBe(path.resolve(fixture.path));
		});

		it('returns no path for a missing OPENCODE_DATA_DIR', () => {
			vi.stubEnv(OPENCODE_CONFIG_DIR_ENV, '/path/that/does/not/exist');

			expect(getOpenCodePath()).toBeNull();
		});

		it('returns directories for comma-separated OPENCODE_DATA_DIR entries', async () => {
			await using fixture1 = await createFixture({
				storage: {},
			});
			await using fixture2 = await createFixture({
				storage: {},
			});
			vi.stubEnv(OPENCODE_CONFIG_DIR_ENV, `${fixture1.path}, ,${fixture2.path},`);

			expect(getOpenCodePaths()).toEqual([
				path.resolve(fixture1.path),
				path.resolve(fixture2.path),
			]);
		});

		it('discovers JSON message files', async () => {
			await using fixture = await createFixture({
				storage: {
					message: {
						'a.json': '{}',
						'ignore.txt': 'no',
					},
				},
			});

			await expect(discoverOpenCodeMessageFiles(fixture.path)).resolves.toEqual([
				fixture.getPath('storage/message/a.json'),
			]);
		});
	});
}
