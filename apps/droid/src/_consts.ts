/**
 * @fileoverview Default paths and constants for Factory Droid usage tracking.
 */

import os from 'node:os';
import path from 'node:path';

export const FACTORY_DIR_ENV = 'FACTORY_DIR';
export const DEFAULT_FACTORY_DIR = path.join(os.homedir(), '.factory');
export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
export const DEFAULT_LOCALE = 'en-CA';

export const DROID_LOG_GLOB = 'droid-log-*.log';
export const FACTORY_LOGS_SUBDIR = 'logs';
export const FACTORY_SESSIONS_SUBDIR = 'sessions';
