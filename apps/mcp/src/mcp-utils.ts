import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_PROJECTS_DIR_NAME = 'projects';

export type LoadOptions = {
	claudePath?: string;
	mode?: 'auto' | 'calculate' | 'display';
	since?: string;
	timezone?: string;
	until?: string;
};

function isDirectory(value: string): boolean {
	try {
		return existsSync(value) && statSync(value).isDirectory();
	} catch {
		return false;
	}
}

export function getClaudePaths(): string[] {
	const paths: string[] = [];
	const normalizedPaths = new Set<string>();

	const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
	if (envPaths !== '') {
		for (const envPath of envPaths
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p !== '')) {
			const normalizedPath = path.resolve(envPath);
			if (isDirectory(path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME))) {
				normalizedPaths.add(normalizedPath);
				paths.push(normalizedPath);
			}
		}
		if (paths.length > 0) {
			return paths;
		}
		throw new Error(
			`No valid Claude data directories found in CLAUDE_CONFIG_DIR. Please ensure the following exists:
- ${envPaths}/${CLAUDE_PROJECTS_DIR_NAME}`.trim(),
		);
	}

	for (const defaultPath of [
		path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'claude'),
		path.join(homedir(), '.claude'),
	]) {
		const normalizedPath = path.resolve(defaultPath);
		if (
			!normalizedPaths.has(normalizedPath) &&
			isDirectory(path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME))
		) {
			normalizedPaths.add(normalizedPath);
			paths.push(normalizedPath);
		}
	}

	if (paths.length === 0) {
		throw new Error(
			`No valid Claude data directories found. Please ensure at least one Claude config directory contains a '${CLAUDE_PROJECTS_DIR_NAME}' subdirectory`,
		);
	}

	return paths;
}

export function defaultOptions(): LoadOptions {
	const paths = getClaudePaths();
	if (paths.length === 0) {
		throw new Error(
			'No valid Claude path found. Ensure getClaudePaths() returns at least one valid path.',
		);
	}
	return { claudePath: paths[0] } as const satisfies LoadOptions;
}
