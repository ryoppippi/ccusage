import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const OPENCODE_DATA_DIR_ENV = 'OPENCODE_DATA_DIR';

function getXdgDataHome(): string {
	return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

export const DEFAULT_OPENCODE_DIR = path.join(getXdgDataHome(), 'opencode', 'storage');

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
export const DEFAULT_LOCALE = 'en-CA';
export const DEFAULT_PRECISION = 2;

export const MILLION = 1_000_000;
