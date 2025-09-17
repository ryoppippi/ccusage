import process from 'node:process';
import consola from 'consola';

export const logger = consola.create({
	level: Number(process.env.LOG_LEVEL ?? 3),
});

export function log(message: string): void {
	logger.log(message);
}
