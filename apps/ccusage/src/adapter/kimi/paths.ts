import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const KIMI_DATA_DIR_ENV = 'KIMI_DATA_DIR';
const DEFAULT_KIMI_DIR = path.join(homedir(), '.kimi');
const KIMI_SESSIONS_DIR_NAME = 'sessions';
const KIMI_WIRE_FILE_NAME = 'wire.jsonl';

export function getKimiPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[KIMI_DATA_DIR_ENV], [DEFAULT_KIMI_DIR]),
	);
}

function isKimiWireFile(sessionsPath: string, filePath: string): boolean {
	const relativePath = path.relative(sessionsPath, filePath);
	const segments = relativePath.split(path.sep);
	return segments.length === 3 && segments[2] === KIMI_WIRE_FILE_NAME;
}

export async function discoverKimiWireFiles(): Promise<string[]> {
	const files = await Promise.all(
		getKimiPaths().map(async (kimiPath) => {
			const sessionsPath = path.join(kimiPath, KIMI_SESSIONS_DIR_NAME);
			if (!isDirectorySyncSafe(sessionsPath)) {
				return [];
			}
			const wireFiles = await collectFilesRecursive(sessionsPath, { extension: '.jsonl' });
			return wireFiles.filter((filePath) => isKimiWireFile(sessionsPath, filePath));
		}),
	);
	return files.flat().sort(compareStrings);
}

export async function detectKimiWireFiles(): Promise<boolean> {
	return (await discoverKimiWireFiles()).length > 0;
}

if (import.meta.vitest != null) {
	describe('Kimi path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses KIMI_DATA_DIR when it points to an existing directory', async () => {
			await using fixture = await createFixture({
				sessions: {},
			});
			vi.stubEnv(KIMI_DATA_DIR_ENV, fixture.path);

			expect(getKimiPaths()).toEqual([path.resolve(fixture.path)]);
		});

		it('discovers wire JSONL files under sessions/*/*', async () => {
			await using fixture = await createFixture({
				sessions: {
					group: {
						session: {
							'wire.jsonl': '{}\n',
							'other.jsonl': '{}\n',
						},
					},
					nested: {
						path: {
							session: {
								'wire.jsonl': '{}\n',
							},
						},
					},
				},
			});
			vi.stubEnv(KIMI_DATA_DIR_ENV, fixture.path);

			await expect(discoverKimiWireFiles()).resolves.toEqual([
				fixture.getPath('sessions/group/session/wire.jsonl'),
			]);
		});
	});
}
