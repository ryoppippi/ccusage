import { createLogger, log as internalLog } from '@ccusage/internal/logger';

export const logger = createLogger('@ccusage/codex');

export const log = internalLog;
