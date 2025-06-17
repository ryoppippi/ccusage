import { consola, type ConsolaInstance } from 'consola';

import { name } from '../package.json';

/**
 * Application logger instance with package name tag
 */
export const logger: ConsolaInstance = consola.withTag(name);

/**
 * Direct console.log function for cases where logger formatting is not desired
 */
// eslint-disable-next-line no-console
export const log = console.log;
