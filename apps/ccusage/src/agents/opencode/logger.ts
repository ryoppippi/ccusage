import { createLogger, log as internalLog } from '@ccusage/internal/logger';

export const logger = createLogger('@ccusage/opencode');

export const log = internalLog;
