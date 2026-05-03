import process from 'node:process';
import { format } from 'node:util';
import { createLogger } from '@ccusage/internal/logger';

import { name } from '../package.json';

export const logger = createLogger(name);

export function log(...args: unknown[]): void {
	process.stdout.write(`${format(...args)}\n`);
}
