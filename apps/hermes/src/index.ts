#!/usr/bin/env node

/**
 * @fileoverview Main entry point for ccusage-hermes CLI tool
 *
 * This is the main entry point for the Hermes usage analysis command-line interface.
 * It provides analysis of Hermes Agent usage data from the local SQLite database.
 *
 * @module index
 */

/* eslint-disable antfu/no-top-level-await */
import { run } from './run.ts';

await run();
