#!/usr/bin/env node

/**
 * @fileoverview Main entry point for ccusage CLI tool
 *
 * This is the main entry point for the ccusage command-line interface tool.
 * It provides analysis of Claude Code usage data from local JSONL files.
 *
 * @module index
 */

/* eslint-disable antfu/no-top-level-await */

import { run } from './commands/index.ts';

await run();
