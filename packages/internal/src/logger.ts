import type { ConsolaInstance } from 'consola';
import process from 'node:process';
import { consola } from 'consola';

export function createLogger(name: string): ConsolaInstance {
	const logger: ConsolaInstance = consola.withTag(name);

	// Apply LOG_LEVEL environment variable if set
	if (process.env.LOG_LEVEL != null) {
		const level = Number.parseInt(process.env.LOG_LEVEL, 10);
		if (!Number.isNaN(level)) {
			logger.level = level;
		}
	}

	return logger;
}

// eslint-disable-next-line no-console
export const log = console.log;
