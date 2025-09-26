/**
 * @fileoverview Logging utilities for the better-ccusage application
 *
 * This module provides configured logger instances using consola for consistent
 * logging throughout the application with package name tagging.
 *
 * @module logger
 */

import { createLogger, log as internalLog } from '@better-ccusage/internal/logger';

import { name } from '../package.json';

/**
 * Application logger instance with package name tag
 */
export const logger = createLogger(name);

/**
 * Direct console.log function for cases where logger formatting is not desired
 */
export const log = internalLog;
