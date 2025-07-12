/**
 * @fileoverview Logging utilities for the ccusage application
 *
 * This module provides configured logger instances using consola for consistent
 * logging throughout the application with package name tagging.
 *
 * @module logger
 */

import type { ConsolaInstance } from 'consola';
import { consola } from 'consola';
import { name } from '../package.json';

import { i18n } from './_i18n.ts';

/**
 * Application logger instance with package name tag
 */
export const logger: ConsolaInstance = consola.withTag(name);

/**
 * Direct console.log function for cases where logger formatting is not desired
 */
// eslint-disable-next-line no-console
export const log = console.log;

/**
 * Logger helper functions with pre-translated messages
 */
export const loggerHelpers = {
	/**
	 * Warn about no data found
	 */
	warnNoData(): void {
		logger.warn(i18n.t('messages.errors.noData'));
	},

	/**
	 * Info about fetching pricing data
	 */
	infoFetchingPricing(): void {
		logger.info(i18n.t('messages.info.fetchingPricing'));
	},

	/**
	 * Info about pricing data loaded with count
	 * @param count - Number of models loaded
	 */
	infoPricingLoaded(count: number): void {
		logger.info(i18n.t('messages.info.pricingLoaded', count));
	},
};
