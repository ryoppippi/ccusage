import path from 'node:path';
import { isDirectorySyncSafe } from '@ccusage/internal/fs';

export function normalizePathList(
	value: string | undefined,
	fallback: readonly string[],
): string[] {
	const entries = (() => {
		if (value == null || value.trim() === '') {
			return fallback;
		}
		const parsed = value
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');
		return parsed.length === 0 ? fallback : parsed;
	})();
	const normalizedPaths = new Set<string>();
	for (const entry of entries) {
		normalizedPaths.add(path.resolve(entry));
	}
	return Array.from(normalizedPaths);
}

export function getExistingDirectories(paths: readonly string[]): string[] {
	return paths.filter((entry) => isDirectorySyncSafe(entry));
}
