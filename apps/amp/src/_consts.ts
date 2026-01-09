import path from 'node:path';
import process from 'node:process';

/**
 * Environment variable name for custom Amp data directory
 */
export const AMP_DATA_DIR_ENV = 'AMP_DATA_DIR';

/**
 * Default Amp data directory path (~/.local/share/amp)
 */
const DEFAULT_AMP_PATH = '.local/share/amp';

/**
 * User home directory
 */
const USER_HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();

/**
 * Default Amp data directory (absolute path)
 */
export const DEFAULT_AMP_DIR = path.join(USER_HOME_DIR, DEFAULT_AMP_PATH);

/**
 * Amp threads subdirectory name
 */
export const AMP_THREADS_DIR_NAME = 'threads';

/**
 * Glob pattern for Amp thread files
 */
export const AMP_THREAD_GLOB = '**/*.json';

/**
 * Million constant for pricing calculations
 */
export const MILLION = 1_000_000;
