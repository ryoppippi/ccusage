import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const QWEN_DATA_DIR_ENV = 'QWEN_DATA_DIR';
const DEFAULT_QWEN_DIR = path.join(homedir(), '.qwen');
const QWEN_PROJECTS_DIR_NAME = 'projects';
const QWEN_CHATS_DIR_NAME = 'chats';

export function getQwenPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[QWEN_DATA_DIR_ENV], [DEFAULT_QWEN_DIR]),
	);
}

function isQwenChatFile(filePath: string): boolean {
	return path.basename(path.dirname(filePath)) === QWEN_CHATS_DIR_NAME;
}

export async function discoverQwenChatFiles(): Promise<string[]> {
	const files = await Promise.all(
		getQwenPaths().map(async (qwenPath) => {
			const projectsPath = path.join(qwenPath, QWEN_PROJECTS_DIR_NAME);
			if (!isDirectorySyncSafe(projectsPath)) {
				return [];
			}
			return collectFilesRecursive(projectsPath, { extension: '.jsonl' });
		}),
	);
	return files.flat().filter(isQwenChatFile).sort(compareStrings);
}

export async function detectQwenChatFiles(): Promise<boolean> {
	return (await discoverQwenChatFiles()).length > 0;
}

if (import.meta.vitest != null) {
	describe('Qwen path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses QWEN_DATA_DIR when it points to an existing directory', async () => {
			await using fixture = await createFixture({
				projects: {},
			});
			vi.stubEnv(QWEN_DATA_DIR_ENV, fixture.path);

			expect(getQwenPaths()).toEqual([path.resolve(fixture.path)]);
		});

		it('discovers chat JSONL files under projects/*/chats', async () => {
			await using fixture = await createFixture({
				projects: {
					workspace: {
						chats: {
							'chat.jsonl': '{}\n',
							'ignore.txt': '{}\n',
						},
					},
				},
			});
			vi.stubEnv(QWEN_DATA_DIR_ENV, fixture.path);

			await expect(discoverQwenChatFiles()).resolves.toEqual([
				fixture.getPath('projects/workspace/chats/chat.jsonl'),
			]);
		});
	});
}
