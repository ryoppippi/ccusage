import type { SessionSource } from './_types.ts';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CODEX_HOME_ENV, DEFAULT_CODEX_DIR, DEFAULT_SESSION_SUBDIR } from './_consts.ts';

type ParsedCodexHome = {
	account?: string;
	codexHome: string;
};

const DEFAULT_ACCOUNT = 'default';

function toNonEmpty(value: string | undefined): string | undefined {
	if (value == null) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function expandHomeDirectory(pathValue: string): string {
	return pathValue.replace(/^~(?=$|[\\/])/, os.homedir());
}

function parseCodexHomeEntry(entry: string): ParsedCodexHome | null {
	const trimmed = entry.trim();
	if (trimmed === '') {
		return null;
	}

	const separatorIndex = trimmed.indexOf('=');
	if (separatorIndex < 0) {
		return {
			codexHome: trimmed,
		};
	}

	const account = toNonEmpty(trimmed.slice(0, separatorIndex));
	const codexHome = toNonEmpty(trimmed.slice(separatorIndex + 1));
	if (codexHome == null) {
		return null;
	}

	return {
		account,
		codexHome,
	};
}

function parseCodexHomes(raw: string): ParsedCodexHome[] {
	return raw
		.split(',')
		.map(parseCodexHomeEntry)
		.filter((item): item is ParsedCodexHome => item != null);
}

function normalizeAccountLabel(base: string): string {
	const normalizedBase = base.trim();
	return normalizedBase === '' ? DEFAULT_ACCOUNT : normalizedBase;
}

function makeUniqueAccountLabels(accountBases: string[]): string[] {
	const normalizedBases = accountBases.map(normalizeAccountLabel);
	const reservedLabels = new Set(normalizedBases);
	const usedLabels = new Set<string>();

	return normalizedBases.map((base) => {
		if (!usedLabels.has(base)) {
			usedLabels.add(base);
			return base;
		}

		let suffix = 2;
		for (;;) {
			const candidate = `${base}-${suffix}`;
			const reservedByFutureEntry = reservedLabels.has(candidate) && !usedLabels.has(candidate);
			if (!usedLabels.has(candidate) && !reservedByFutureEntry) {
				usedLabels.add(candidate);
				return candidate;
			}

			suffix += 1;
		}
	});
}

function fallbackAccountLabel(codexHome: string, index: number, total: number): string {
	if (total <= 1) {
		return DEFAULT_ACCOUNT;
	}

	const resolvedCodexHome = path.resolve(expandHomeDirectory(codexHome));
	const baseName = path.basename(resolvedCodexHome);
	const normalizedBase = toNonEmpty(baseName);
	return normalizedBase ?? `account-${index + 1}`;
}

export function resolveSessionSources(codexHomeArg?: string): SessionSource[] {
	const sourceText = toNonEmpty(codexHomeArg) ?? toNonEmpty(process.env[CODEX_HOME_ENV]);
	const parsedHomes =
		sourceText == null || sourceText === ''
			? [{ codexHome: DEFAULT_CODEX_DIR } satisfies ParsedCodexHome]
			: parseCodexHomes(sourceText);

	if (parsedHomes.length === 0) {
		return [
			{
				account: DEFAULT_ACCOUNT,
				directory: path.join(DEFAULT_CODEX_DIR, DEFAULT_SESSION_SUBDIR),
			},
		];
	}

	const accountBases = parsedHomes.map(
		(entry, index) =>
			entry.account ?? fallbackAccountLabel(entry.codexHome, index, parsedHomes.length),
	);
	const uniqueAccounts = makeUniqueAccountLabels(accountBases);

	return parsedHomes.map((entry, index) => {
		const resolvedCodexHome = path.resolve(expandHomeDirectory(entry.codexHome));
		return {
			account: uniqueAccounts[index]!,
			directory: path.join(resolvedCodexHome, DEFAULT_SESSION_SUBDIR),
		};
	});
}

if (import.meta.vitest != null) {
	describe('resolveSessionSources', () => {
		let originalCodexHome: string | undefined;

		beforeEach(() => {
			originalCodexHome = process.env[CODEX_HOME_ENV];
		});

		afterEach(() => {
			if (originalCodexHome == null) {
				delete process.env[CODEX_HOME_ENV];
				return;
			}

			process.env[CODEX_HOME_ENV] = originalCodexHome;
		});

		it('uses default CODEX_HOME when no override is provided', () => {
			delete process.env[CODEX_HOME_ENV];
			const sources = resolveSessionSources();
			expect(sources).toEqual([
				{
					account: 'default',
					directory: path.join(DEFAULT_CODEX_DIR, DEFAULT_SESSION_SUBDIR),
				},
			]);
		});

		it('supports multiple codex homes with automatic labels', () => {
			const sources = resolveSessionSources('/tmp/codex-work,/tmp/codex-personal');
			expect(sources).toEqual([
				{
					account: 'codex-work',
					directory: path.resolve('/tmp/codex-work', DEFAULT_SESSION_SUBDIR),
				},
				{
					account: 'codex-personal',
					directory: path.resolve('/tmp/codex-personal', DEFAULT_SESSION_SUBDIR),
				},
			]);
		});

		it('supports explicit account labels and deduplicates duplicates', () => {
			const sources = resolveSessionSources('work=/tmp/work-a,work=/tmp/work-b');
			expect(sources).toEqual([
				{
					account: 'work',
					directory: path.resolve('/tmp/work-a', DEFAULT_SESSION_SUBDIR),
				},
				{
					account: 'work-2',
					directory: path.resolve('/tmp/work-b', DEFAULT_SESSION_SUBDIR),
				},
			]);
		});

		it('avoids collisions with explicit suffix-style account labels', () => {
			const sources = resolveSessionSources('work=/tmp/work-a,work=/tmp/work-b,work-2=/tmp/work-c');
			expect(sources).toEqual([
				{
					account: 'work',
					directory: path.resolve('/tmp/work-a', DEFAULT_SESSION_SUBDIR),
				},
				{
					account: 'work-3',
					directory: path.resolve('/tmp/work-b', DEFAULT_SESSION_SUBDIR),
				},
				{
					account: 'work-2',
					directory: path.resolve('/tmp/work-c', DEFAULT_SESSION_SUBDIR),
				},
			]);
		});

		it('expands tilde paths in codex homes', () => {
			const sources = resolveSessionSources('work=~/.codex-work');
			expect(sources).toEqual([
				{
					account: 'work',
					directory: path.resolve(os.homedir(), '.codex-work', DEFAULT_SESSION_SUBDIR),
				},
			]);
		});
	});
}
