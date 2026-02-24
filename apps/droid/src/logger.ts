/**
 * @fileoverview App-scoped logger binding.
 */

import { createLogger, log as internalLog } from '@ccusage/internal/logger';

import { name } from '../package.json';

export const logger = createLogger(name);

/**
 * Unscoped low-level log helper used by other ccusage apps.
 */
export const log = internalLog;
