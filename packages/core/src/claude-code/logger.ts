import process from 'node:process';

const debugEnabled = process.env.CCUSAGE_CORE_DEBUG === '1';

export const logger = {
	debug: (...args: unknown[]): void => {
		if (!debugEnabled) {
			return;
		}
		// eslint-disable-next-line no-console
		console.debug('[ccusage:core]', ...args);
	},
};
