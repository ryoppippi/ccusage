import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, hasFileRecursive } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const CODEBUFF_DATA_DIR_ENV = 'CODEBUFF_DATA_DIR';
const CODEBUFF_PROJECTS_DIR_NAME = 'projects';
const DEFAULT_CODEBUFF_CHANNEL_DIRS = ['manicode', 'manicode-dev', 'manicode-staging'] as const;

function getDefaultCodebuffRoots(): string[] {
	const configDir = path.join(os.homedir(), '.config');
	return DEFAULT_CODEBUFF_CHANNEL_DIRS.map((channel) => path.join(configDir, channel));
}

export function getCodebuffProjectRoots(): string[] {
	const roots = normalizePathList(process.env[CODEBUFF_DATA_DIR_ENV], getDefaultCodebuffRoots());
	return getExistingDirectories(
		roots.map((root) =>
			path.basename(root) === CODEBUFF_PROJECTS_DIR_NAME
				? root
				: path.join(root, CODEBUFF_PROJECTS_DIR_NAME),
		),
	);
}

export async function discoverCodebuffChatFiles(): Promise<string[]> {
	const files = await Promise.all(
		getCodebuffProjectRoots().map(async (projectRoot) =>
			collectFilesRecursive(projectRoot, { extension: '.json' }),
		),
	);
	return files.flat().filter((file) => path.basename(file) === 'chat-messages.json');
}

export async function detectCodebuffChatFiles(): Promise<boolean> {
	const results = await Promise.all(
		getCodebuffProjectRoots().map(async (projectRoot) =>
			hasFileRecursive(projectRoot, { extension: '.json' }),
		),
	);
	if (!results.some(Boolean)) {
		return false;
	}
	return (await discoverCodebuffChatFiles()).length > 0;
}

if (import.meta.vitest != null) {
	describe('Codebuff path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('uses CODEBUFF_DATA_DIR as channel roots and scans their projects directories', async () => {
			await using fixture = await createFixture({
				projects: {
					project: {
						chats: {
							chat: {
								'chat-messages.json': '[]',
								'run-state.json': '{}',
							},
						},
					},
				},
			});
			vi.stubEnv(CODEBUFF_DATA_DIR_ENV, fixture.path);

			expect(getCodebuffProjectRoots()).toEqual([fixture.getPath('projects')]);
			await expect(discoverCodebuffChatFiles()).resolves.toEqual([
				fixture.getPath('projects/project/chats/chat/chat-messages.json'),
			]);
			await expect(detectCodebuffChatFiles()).resolves.toBe(true);
		});
	});
}
