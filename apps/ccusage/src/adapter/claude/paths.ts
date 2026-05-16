import path from 'node:path';
import process from 'node:process';
import { USER_HOME_DIR } from '../../consts.ts';
import {
	CLAUDE_CONFIG_DIR_ENV,
	CLAUDE_PROJECTS_DIR_NAME,
	DEFAULT_CLAUDE_CODE_PATH,
	DEFAULT_CLAUDE_CONFIG_PATH,
} from './constants.ts';

export function getClaudeProjectPaths(): string[] {
	const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
	const basePaths =
		envPaths === ''
			? [DEFAULT_CLAUDE_CONFIG_PATH, path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH)]
			: envPaths
					.split(',')
					.map((entry) => entry.trim())
					.filter((entry) => entry !== '')
					.map((entry) => path.resolve(entry));
	return basePaths.map((basePath) => path.join(basePath, CLAUDE_PROJECTS_DIR_NAME));
}

if (import.meta.vitest != null) {
	describe('getClaudeProjectPaths', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('ignores empty CLAUDE_CONFIG_DIR entries before resolving paths so cwd is never added accidentally', () => {
			vi.stubEnv(CLAUDE_CONFIG_DIR_ENV, '/tmp/claude-a, ,/tmp/claude-b,');

			expect(getClaudeProjectPaths()).toEqual([
				path.join('/tmp/claude-a', CLAUDE_PROJECTS_DIR_NAME),
				path.join('/tmp/claude-b', CLAUDE_PROJECTS_DIR_NAME),
			]);
		});
	});
}
