import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Environment variable name for custom Copilot data directory
 */
export const COPILOT_CONFIG_DIR_ENV = 'COPILOT_CONFIG_DIR';

/**
 * Default Copilot data directory path (~/.copilot)
 */
const DEFAULT_COPILOT_PATH = '.copilot';

/**
 * User home directory
 */
const USER_HOME_DIR = homedir();

/**
 * Default Copilot data directory (absolute path)
 */
export const DEFAULT_COPILOT_DIR = path.join(USER_HOME_DIR, DEFAULT_COPILOT_PATH);

/**
 * Copilot session-state subdirectory name
 */
export const SESSION_STATE_DIR_NAME = 'session-state';

/**
 * Events filename within each session directory
 */
export const EVENTS_FILENAME = 'events.jsonl';

/**
 * Workspace metadata filename within each session directory
 */
export const WORKSPACE_FILENAME = 'workspace.yaml';

/**
 * Million constant for pricing calculations
 */
export const MILLION = 1_000_000;

/**
 * Cost per premium request in USD (GitHub Copilot overage rate)
 */
export const PREMIUM_REQUEST_COST_USD = 0.04;

/**
 * Available pricing modes
 */
export const PRICING_MODES = ['premium', 'api'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/**
 * Default timezone (system local)
 */
export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

/**
 * Default locale for formatting
 */
export const DEFAULT_LOCALE = 'en-US';
