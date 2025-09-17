import type { ConsolaInstance } from 'consola';
import process from 'node:process';
import { consola } from 'consola';

import { name } from '../package.json';

export const logger: ConsolaInstance = consola.withTag(name);

if (process.env.LOG_LEVEL != null) {
	const level = Number.parseInt(process.env.LOG_LEVEL, 10);
	if (!Number.isNaN(level)) {
		logger.level = level;
	}
}
