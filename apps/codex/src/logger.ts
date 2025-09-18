import { createLogger, log as internalLog } from '@ccusage/internal/logger';

import { name } from '../package.json';

export const logger = createLogger(name);

export const log = internalLog;
