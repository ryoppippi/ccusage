import { consola, type ConsolaInstance } from 'consola';

import { name } from '../package.json';

export const logger: ConsolaInstance = consola.withTag(name);

// eslint-disable-next-line no-console
export const log = console.log;
