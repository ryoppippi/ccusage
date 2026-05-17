import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, hasFileRecursive } from '@ccusage/internal/fs';
import { compareStrings } from '@ccusage/internal/sort';
import { createFixture } from 'fs-fixture';
import { getExistingDirectories, normalizePathList } from '../path-list.ts';

export const GEMINI_DATA_DIR_ENV = 'GEMINI_DATA_DIR';
const DEFAULT_GEMINI_DATA_DIR = path.join(os.homedir(), '.gemini', 'tmp');

export function getGeminiPaths(): string[] {
	return getExistingDirectories(
		normalizePathList(process.env[GEMINI_DATA_DIR_ENV], [DEFAULT_GEMINI_DATA_DIR]),
	);
}

export async function discoverGeminiLogFiles(): Promise<string[]> {
	const fileGroups = await Promise.all(
		getGeminiPaths().flatMap((geminiPath) => [
			collectFilesRecursive(geminiPath, { extension: '.json' }),
			collectFilesRecursive(geminiPath, { extension: '.jsonl' }),
		]),
	);
	return fileGroups.flat().sort(compareStrings);
}

export async function detectGeminiLogFiles(): Promise<boolean> {
	const results = await Promise.all(
		getGeminiPaths().flatMap((geminiPath) => [
			hasFileRecursive(geminiPath, { extension: '.json' }),
			hasFileRecursive(geminiPath, { extension: '.jsonl' }),
		]),
	);
	return results.some(Boolean);
}

if (import.meta.vitest != null) {
	describe('Gemini path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('discovers JSON and JSONL files under the Gemini data directory', async () => {
			await using fixture = await createFixture({
				chats: {
					'a.json': '{}',
					'b.jsonl': '{}\n',
					'ignore.txt': 'no',
				},
			});
			vi.stubEnv(GEMINI_DATA_DIR_ENV, fixture.path);

			await expect(discoverGeminiLogFiles()).resolves.toEqual([
				fixture.getPath('chats/a.json'),
				fixture.getPath('chats/b.jsonl'),
			]);
			await expect(detectGeminiLogFiles()).resolves.toBe(true);
		});
	});
}
