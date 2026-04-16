import { homedir } from 'node:os';

export const DEFAULT_OPENCODE_PATH = '.local/share/opencode';
export const OPENCODE_STORAGE_DIR_NAME = 'storage';
export const OPENCODE_MESSAGES_DIR_NAME = 'message';
export const OPENCODE_SESSIONS_DIR_NAME = 'session';
export const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';
export const USER_HOME_DIR = homedir();
export const CHANNEL_DB_PATTERN = /^opencode-.+\.db$/;
