#!/usr/bin/env node

/**
 * @fileoverview Package entrypoint for the `ccusage-droid` binary.
 */

import { run } from './run.ts';

// eslint-disable-next-line antfu/no-top-level-await
await run();
