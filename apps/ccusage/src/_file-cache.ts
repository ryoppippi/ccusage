/**
 * @fileoverview Per-file cache for JSONL usage data
 *
 * Caches parsed entries per file, keyed by file path + mtime + size.
 * Unchanged files are never re-read from disk, giving ~100x speedup
 * for users with thousands of session files.
 *
 * Cache location: $XDG_CACHE_HOME/ccusage/data-cache-v1.json
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CACHE_VERSION = 1;

function getCacheDir(): string {
	const xdgCache = process.env.XDG_CACHE_HOME;
	return path.join(xdgCache ?? path.join(homedir(), '.cache'), 'ccusage');
}

function getCacheFile(): string {
	return path.join(getCacheDir(), `data-cache-v${CACHE_VERSION}.json`);
}

/**
 * Compact representation of a cached entry.
 * Fields are shortened to minimize cache file size.
 * Content field is intentionally omitted (only needed for blocks view).
 */
export type CompactEntry = {
	/** ISO timestamp */
	t: string;
	/** model name */
	m?: string;
	/** message ID */
	mi?: string;
	/** request ID */
	ri?: string;
	/** session ID */
	si?: string;
	/** [input_tokens, output_tokens, cache_creation, cache_read] */
	u: [number, number, number, number];
	/** speed: 'fast' or undefined (standard) */
	sp?: string;
	/** costUSD */
	c?: number;
	/** version */
	v?: string;
	/** isApiErrorMessage */
	ae?: true;
	/** cwd */
	cwd?: string;
}

export type CachedFileData = {
	/** file mtime in ms */
	mt: number;
	/** file size in bytes */
	sz: number;
	/** earliest timestamp in the file (ISO string) */
	et: string | null;
	/** latest timestamp in the file (ISO string) */
	lt: string | null;
	/** compact entries */
	e: CompactEntry[];
}

type CacheStore = {
	version: number;
	files: Record<string, CachedFileData>;
}

let store: CacheStore | null = null;
let dirty = false;

/**
 * In-memory stat cache to avoid redundant stat() syscalls within a single run.
 * Each file is stat'd at most once — subsequent calls return the cached result.
 */
const statCache = new Map<string, { mtimeMs: number; size: number } | null>();

export async function statCached(
	filePath: string,
): Promise<{ mtimeMs: number; size: number } | null> {
	if (statCache.has(filePath)) {return statCache.get(filePath) ?? null;}
	try {
		const stats = await stat(filePath);
		const result = { mtimeMs: stats.mtimeMs, size: stats.size };
		statCache.set(filePath, result);
		return result;
	} catch {
		statCache.set(filePath, null);
		return null;
	}
}

/**
 * Load the cache from disk. Returns in-memory store on subsequent calls.
 */
export async function getCache(): Promise<CacheStore> {
	if (store != null) {return store;}

	const cacheFile = getCacheFile();
	try {
		if (existsSync(cacheFile)) {
			const raw = await readFile(cacheFile, 'utf-8');
			const parsed = JSON.parse(raw) as CacheStore;
			if (parsed?.version === CACHE_VERSION && parsed?.files != null) {
				store = parsed;
				return store;
			}
		}
	} catch {
		// Cache corrupted or incompatible, start fresh
	}

	store = { version: CACHE_VERSION, files: {} };
	return store;
}

/**
 * Check if a file has a valid cache entry (mtime + size match).
 */
export async function getCachedFileData(filePath: string): Promise<CachedFileData | null> {
	const cache = await getCache();
	const cached = cache.files[filePath];
	if (cached == null) {return null;}

	const stats = await statCached(filePath);
	if (stats != null && stats.mtimeMs === cached.mt && stats.size === cached.sz) {
		return cached;
	}

	// Stale cache entry
	delete cache.files[filePath];
	dirty = true;
	return null;
}

/**
 * Store parsed file data in the cache.
 */
export async function setCachedFileData(filePath: string, data: CachedFileData): Promise<void> {
	const cache = await getCache();
	cache.files[filePath] = data;
	dirty = true;
}

/**
 * Write the cache to disk if modified.
 */
export async function saveCache(): Promise<void> {
	if (!dirty || store == null) {return;}

	try {
		const dir = getCacheDir();
		mkdirSync(dir, { recursive: true });
		await writeFile(getCacheFile(), JSON.stringify(store));
		dirty = false;
	} catch {
		// Best effort — don't crash if cache write fails
	}
}

/**
 * Fast pre-filter: check if a file MIGHT contain entries within a date range
 * using only cached metadata (no stat or file I/O).
 * Returns true if the file should be processed, false if it can be safely skipped.
 *
 * @param sinceDate - YYYYMMDD format lower bound (inclusive), or undefined
 * @param untilDate - YYYYMMDD format upper bound (inclusive), or undefined
 */
export async function mightContainEntriesInRange(
	filePath: string,
	sinceDate: string | undefined,
	untilDate: string | undefined,
): Promise<boolean> {
	if (sinceDate == null && untilDate == null) {return true;}

	const cache = await getCache();
	const cached = cache.files[filePath];
	if (cached == null) {return true;} // Unknown file, must process

	// Convert ISO timestamps to YYYYMMDD for comparison
	const earliest = cached.et?.slice(0, 10).replace(/-/g, '') ?? null;
	const latest = cached.lt?.slice(0, 10).replace(/-/g, '') ?? null;

	if (earliest == null || latest == null) {return true;} // No timestamp info, must process

	// If file's latest entry is before since date, skip it
	if (sinceDate != null && latest < sinceDate) {return false;}

	// If file's earliest entry is after until date, skip it
	if (untilDate != null && earliest > untilDate) {return false;}

	return true;
}

/**
 * Remove entries for files that no longer exist on disk.
 */
export async function pruneCache(existingFiles: Set<string>): Promise<void> {
	const cache = await getCache();
	for (const filePath of Object.keys(cache.files)) {
		if (!existingFiles.has(filePath)) {
			delete cache.files[filePath];
			dirty = true;
		}
	}
}

/**
 * Reset in-memory cache (for testing).
 */
export function resetCache(): void {
	store = null;
	dirty = false;
	statCache.clear();
}
