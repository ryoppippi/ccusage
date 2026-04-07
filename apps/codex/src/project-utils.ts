import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const UNKNOWN_PROJECT_LABEL = '(unknown)';
export const MIXED_PROJECT_LABEL = '(mixed)';

function expandHomeDirectory(value: string): string {
	if (value === '~') {
		return os.homedir();
	}

	if (value.startsWith('~/') || value.startsWith('~\\')) {
		return path.join(os.homedir(), value.slice(2));
	}

	return value;
}

// On Windows, the filesystem is case-insensitive, so we compare the home prefix
// case-insensitively while preserving the original casing in the returned path.
const IS_CASE_INSENSITIVE_FS = process.platform === 'win32';

function equalsPathSegment(a: string, b: string): boolean {
	return IS_CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function normalizeProjectPath(value: string): string {
	let normalized = path.normalize(expandHomeDirectory(value.trim()));
	const home = path.normalize(os.homedir());
	const root = path.parse(normalized).root;

	while (normalized.length > root.length && normalized.endsWith(path.sep)) {
		normalized = normalized.slice(0, -path.sep.length);
	}

	if (equalsPathSegment(normalized, home)) {
		return '~';
	}

	const homePrefix = home + path.sep;
	if (
		normalized.length > homePrefix.length &&
		equalsPathSegment(normalized.slice(0, homePrefix.length), homePrefix)
	) {
		return `~${path.sep}${normalized.slice(homePrefix.length)}`;
	}

	return normalized;
}

export function normalizeProjectFilter(value: string | undefined): string | undefined {
	if (value == null) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : normalizeProjectPath(trimmed);
}

if (import.meta.vitest != null) {
	describe('normalizeProjectPath', () => {
		it('replaces home directory with ~', () => {
			const home = os.homedir();
			expect(normalizeProjectPath(`${home}/workspace/foo`)).toBe('~/workspace/foo');
		});

		it('normalizes explicit tilde paths to the same project key', () => {
			expect(normalizeProjectPath('~/workspace/foo/')).toBe('~/workspace/foo');
		});

		it('returns exact home as ~', () => {
			expect(normalizeProjectPath(os.homedir())).toBe('~');
		});

		it('does not corrupt paths that share the home prefix string', () => {
			const home = os.homedir();
			expect(normalizeProjectPath(`${home}-backup/repo`)).toBe(`${home}-backup/repo`);
		});

		it('leaves non-home paths unchanged', () => {
			expect(normalizeProjectPath('/opt/projects/foo')).toBe('/opt/projects/foo');
		});
	});

	describe('normalizeProjectFilter', () => {
		it('treats blank filters as absent', () => {
			expect(normalizeProjectFilter('   ')).toBeUndefined();
		});
	});
}
