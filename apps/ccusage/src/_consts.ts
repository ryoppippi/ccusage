import { homedir } from 'node:os';
import { xdgConfig } from 'xdg-basedir';

/**
 * URL for LiteLLM's model pricing and context window data
 */
export const LITELLM_PRICING_URL
	= 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

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
const XDG_CONFIG_DIR = xdgConfig ?? `${USER_HOME_DIR}/.config`;

/**
 * Default Claude data directory path (~/.claude)
 * Used as base path for loading usage data from JSONL files
 */
export const DEFAULT_CLAUDE_CODE_PATH = '.claude';

/**
 * Default Claude data directory path using XDG config directory
 * Uses XDG_CONFIG_HOME if set, otherwise falls back to ~/.config/claude
 */
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

/**
 * Default port for MCP server HTTP transport
 * Used when no port is specified for MCP server communication
 */
export const MCP_DEFAULT_PORT = 8080;

/**
 * Default refresh interval in seconds for live monitoring mode
 * Used in blocks command for real-time updates
 */
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 1;

/**
 * Minimum refresh interval in seconds for live monitoring mode
 * Prevents too-frequent updates that could impact performance
 */
export const MIN_REFRESH_INTERVAL_SECONDS = 1;

/**
 * Maximum refresh interval in seconds for live monitoring mode
 * Prevents too-slow updates that reduce monitoring effectiveness
 */
export const MAX_REFRESH_INTERVAL_SECONDS = 60;

/**
 * Frame rate limit for live monitoring (16ms = ~60fps)
 * Prevents terminal flickering and excessive CPU usage during rapid updates
 */
export const MIN_RENDER_INTERVAL_MS = 16;

/**
 * Burn rate thresholds for indicator display (tokens per minute)
 */
export const BURN_RATE_THRESHOLDS = {
	HIGH: 1000,
	MODERATE: 500,
} as const;

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
export const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * Week day names type
 */
export type WeekDay = typeof WEEK_DAYS[number];

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
