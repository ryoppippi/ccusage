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
