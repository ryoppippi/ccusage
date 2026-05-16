import { homedir } from 'node:os';
import path from 'node:path';
import { xdgConfig } from 'xdg-basedir';

/**
 * Default number of recent days to include when filtering blocks
 * Used in both session blocks and commands for consistent behavior
 */
export const DEFAULT_RECENT_DAYS = 3;

/**
 * Threshold percentage for showing usage warnings in blocks command (80%)
 * When usage exceeds this percentage of limits, warnings are displayed
 */
export const BLOCKS_WARNING_THRESHOLD = 0.8;

/**
 * Terminal width threshold for switching to compact display mode in blocks command
 * Below this width, tables use more compact formatting
 */
export const BLOCKS_COMPACT_WIDTH_THRESHOLD = 120;

/**
 * Default terminal width when stdout.columns is not available in blocks command
 * Used as fallback for responsive table formatting
 */
export const BLOCKS_DEFAULT_TERMINAL_WIDTH = 120;

/**
 * Threshold percentage for considering costs as matching (0.1% tolerance)
 * Used in debug cost validation to allow for minor calculation differences
 */
export const DEBUG_MATCH_THRESHOLD_PERCENT = 0.1;

/**
 * User's home directory path
 * Centralized access to OS home directory for consistent path building
 */
export const USER_HOME_DIR = homedir();

/**
 * XDG config directory path
 * Uses XDG_CONFIG_HOME if set, otherwise falls back to ~/.config
 */
export const XDG_CONFIG_DIR = xdgConfig ?? path.join(USER_HOME_DIR, '.config');

/**
 * JSONL file glob pattern for finding usage data files
 * Used to recursively find all JSONL files in project directories
 */
export const USAGE_DATA_GLOB_PATTERN = '**/*.jsonl';

/**
 * Default refresh interval in seconds for statusline cache expiry
 */
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 1;

/**
 * Context usage percentage thresholds for color coding
 */
export const DEFAULT_CONTEXT_USAGE_THRESHOLDS = {
	LOW: 50, // Below 50% - green
	MEDIUM: 80, // 50-80% - yellow
	// Above 80% - red
} as const;

/**
 * Days of the week for weekly aggregation
 */
export const WEEK_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
] as const;

/**
 * Week day names type
 */
export type WeekDay = (typeof WEEK_DAYS)[number];

/**
 * Day of week as number (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Default configuration file name for storing usage data
 * Used to load and save configuration settings
 */
export const CONFIG_FILE_NAME = 'ccusage.json';

/**
 * Default locale for date formatting (en-CA provides YYYY-MM-DD ISO format)
 * Used consistently across the application for date parsing and display
 */
export const DEFAULT_LOCALE = 'en-CA';
