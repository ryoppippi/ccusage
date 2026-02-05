import os from 'node:os';
import path from 'node:path';

export const KIMI_SHARE_DIR_ENV = 'KIMI_SHARE_DIR';
export const KIMI_MODEL_NAME_ENV = 'KIMI_MODEL_NAME';
export const DEFAULT_KIMI_DIR = path.join(os.homedir(), '.kimi');
export const KIMI_SESSIONS_DIR_NAME = 'sessions';
export const KIMI_WIRE_FILE_NAME = 'wire.jsonl';
export const KIMI_CONFIG_FILE_NAME = 'config.toml';
export const KIMI_METADATA_FILE_NAME = 'kimi.json';

export const WIRE_GLOB = `*/${KIMI_WIRE_FILE_NAME}`;
export const SESSION_GLOB = `*/${WIRE_GLOB}`;

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
export const DEFAULT_LOCALE = 'en-CA';

export const MILLION = 1_000_000;
