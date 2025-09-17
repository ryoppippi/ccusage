/**
 * @fileoverview Logging utilities for the ccusage application
 *
 * This module provides configured logger instances using consola for consistent
 * logging throughout the application with package name tagging.
 *
 * @module logger
 */

import type { ConsolaInstance } from 'consola';
import process from 'node:process';
import { consola } from 'consola';

import { name } from '../package.json';

/**
 * Application logger instance with package name tag
 */
export const logger: ConsolaInstance = consola.withTag(name);

// Apply LOG_LEVEL environment variable if set
if (process.env.LOG_LEVEL != null) {
	const level = Number.parseInt(process.env.LOG_LEVEL, 10);
	if (!Number.isNaN(level)) {
		logger.level = level;
	}
}

/**
 * Direct console.log function for cases where logger formatting is not desired
 */
// eslint-disable-next-line no-console
export const log = console.log;
