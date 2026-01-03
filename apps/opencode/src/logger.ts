import { createLogger } from '@ccusage/internal/logger';

export const logger = createLogger('opencode');

export function log(message: string): void {
	// eslint-disable-next-line no-console
	console.log(message);
}
