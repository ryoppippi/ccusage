import { createLogger, log } from '@ccusage/internal/logger';

import { name } from '../package.json';

export const logger = createLogger(name);

export { log };
