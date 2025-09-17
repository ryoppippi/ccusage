import { xdgConfig } from 'xdg-basedir';
import { USER_HOME_DIR } from './consts.ts';

/**
 * Default Claude data directory path (~/.claude)
 * Used as base path for loading usage data from JSONL files
 */
export const DEFAULT_CLAUDE_CODE_PATH = '.claude';

/**
 * Default Claude data directory path using XDG config directory
 * Uses XDG_CONFIG_HOME if set, otherwise falls back to ~/.config/claude
 */
const XDG_CONFIG_DIR = xdgConfig ?? `${USER_HOME_DIR}/.config`;
export const DEFAULT_CLAUDE_CONFIG_PATH = `${XDG_CONFIG_DIR}/claude`;

/**
 * Environment variable for specifying multiple Claude data directories
 * Supports comma-separated paths for multiple locations
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Claude projects directory name within the data directory
 * Contains subdirectories for each project with usage data
 */
export const CLAUDE_PROJECTS_DIR_NAME = 'projects';

/**
 * JSONL file glob pattern for finding usage data files
 * Used to recursively find all JSONL files in project directories
 */
export const USAGE_DATA_GLOB_PATTERN = '**/*.jsonl';
