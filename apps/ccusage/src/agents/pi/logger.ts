import { createLogger, log as internalLog } from '@ccusage/internal/logger';

export const logger = createLogger('@ccusage/pi');

export const log = internalLog;
