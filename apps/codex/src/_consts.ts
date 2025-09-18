import os from 'node:os';
import path from 'node:path';

export const CODEX_HOME_ENV = 'CODEX_HOME';
export const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
export const DEFAULT_SESSION_SUBDIR = 'sessions';
export const SESSION_GLOB = '**/*.jsonl';
export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
export const DEFAULT_LOCALE = 'en-CA';
export const DEFAULT_PRECISION = 2;

export const MILLION = 1_000_000;

export const PRICING_CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes
