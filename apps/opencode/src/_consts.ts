import { homedir } from "node:os";

/**
 * Default OpenCode data directory path (~/.local/share/opencode)
 */
export const DEFAULT_OPENCODE_PATH = ".local/share/opencode";

/**
 * OpenCode storage subdirectory containing message data
 */
export const OPENCODE_STORAGE_DIR_NAME = "storage";

/**
 * OpenCode messages subdirectory within storage
 */
export const OPENCODE_MESSAGES_DIR_NAME = "message";

/**
 * OpenCode sessions subdirectory within storage
 */
export const OPENCODE_SESSIONS_DIR_NAME = "session";

/**
 * Environment variable for specifying custom OpenCode data directory
 */
export const OPENCODE_CONFIG_DIR_ENV = "OPENCODE_DATA_DIR";

/**
 * User home directory
 */
export const USER_HOME_DIR = homedir();

/**
 * Regex pattern matching channel-variant SQLite database filenames (e.g. opencode-beta.db, opencode-canary.db)
 */
export const CHANNEL_DB_PATTERN = /^opencode-.+\.db$/;
