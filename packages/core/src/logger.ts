import process from 'node:process';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

function getConfiguredLevel(): number {
	const raw = process.env.CCUSAGE_CORE_LOG_LEVEL ?? process.env.LOG_LEVEL;
	if (raw == null) {
		return LEVELS.warn;
	}
	const level = Number.parseInt(raw, 10);
	return Number.isNaN(level) ? LEVELS.warn : level;
}

const currentLevel = getConfiguredLevel();

function shouldLog(level: LogLevel): boolean {
	return currentLevel >= LEVELS[level];
}

export const logger = {
	error: (...args: unknown[]): void => {
		if (!shouldLog('error')) {
			return;
		}

		console.error('[ccusage:core]', ...args);
	},
	warn: (...args: unknown[]): void => {
		if (!shouldLog('warn')) {
			return;
		}

		console.warn('[ccusage:core]', ...args);
	},
	info: (...args: unknown[]): void => {
		if (!shouldLog('info')) {
			return;
		}
		// eslint-disable-next-line no-console
		console.info('[ccusage:core]', ...args);
	},
	debug: (...args: unknown[]): void => {
		if (!shouldLog('debug')) {
			return;
		}
		// eslint-disable-next-line no-console
		console.debug('[ccusage:core]', ...args);
	},
} as const;
