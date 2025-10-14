/**
 * @fileoverview Configuration management for codex
 *
 * This module handles loading and accessing codex configuration from:
 * 1. CLI options (highest priority)
 * 2. Environment variables
 * 3. Configuration file (~/.ccusage/config.json) - shared with ccusage
 * 4. Default values (lowest priority)
 *
 * @module config
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as v from 'valibot';
import { logger } from './logger.ts';

/**
 * Environment variable for custom archive path
 */
export const CODEX_ARCHIVE_PATH_ENV = 'CODEX_ARCHIVE_PATH';

/**
 * Default directory for ccusage configuration and data (shared with ccusage)
 */
const DEFAULT_CCUSAGE_DIR = path.join(homedir(), '.ccusage');

/**
 * Default archive directory path (Codex specific)
 */
const DEFAULT_ARCHIVE_DIR = path.join(DEFAULT_CCUSAGE_DIR, 'archive', 'codex');

/**
 * Configuration file path (shared with ccusage)
 */
const CONFIG_FILE_PATH = path.join(DEFAULT_CCUSAGE_DIR, 'config.json');

/**
 * Configuration file schema
 */
const configSchema = v.object({
	archive: v.optional(v.object({
		codex: v.optional(v.string()),
	})),
	autoArchive: v.optional(v.boolean()),
});

/**
 * Configuration type
 */
export type Config = v.InferOutput<typeof configSchema>;

/**
 * Load configuration from file
 * Returns empty object if file doesn't exist or is invalid
 * @returns Configuration object
 */
export function loadConfig(): Config {
	if (!existsSync(CONFIG_FILE_PATH)) {
		logger.debug(`Config file not found: ${CONFIG_FILE_PATH}`);
		return {};
	}

	try {
		const content = readFileSync(CONFIG_FILE_PATH, 'utf-8');
		const json = JSON.parse(content) as unknown;
		return v.parse(configSchema, json);
	}
	catch (error) {
		const errorMessage = error instanceof Error
			? error.message
			: 'Unknown error';
		logger.warn(`Failed to load config file: ${errorMessage}`);
		logger.warn('Using default configuration');
		return {};
	}
}

/**
 * Resolve archive path from various sources
 * Priority: CLI option > Environment variable > Config file > Default
 *
 * @param cliOption - Path specified via CLI option
 * @returns Resolved absolute archive path
 */
export function getArchivePath(cliOption?: string): string {
	// Priority 1: CLI option
	if (cliOption != null && cliOption.trim() !== '') {
		const resolved = resolvePath(cliOption);
		logger.debug(`Using CLI archive path: ${resolved}`);
		return resolved;
	}

	// Priority 2: Environment variable
	const envPath = process.env[CODEX_ARCHIVE_PATH_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const resolved = resolvePath(envPath);
		logger.debug(`Using env archive path: ${resolved}`);
		return resolved;
	}

	// Priority 3: Config file
	const config = loadConfig();
	if (config.archive?.codex != null && config.archive.codex.trim() !== '') {
		const resolved = resolvePath(config.archive.codex);
		logger.debug(`Using config archive path: ${resolved}`);
		return resolved;
	}

	// Priority 4: Default
	logger.debug(`Using default archive path: ${DEFAULT_ARCHIVE_DIR}`);
	return DEFAULT_ARCHIVE_DIR;
}

/**
 * Resolve path with tilde expansion and absolute path conversion
 * @param inputPath - Path to resolve (may contain ~)
 * @returns Absolute path
 */
function resolvePath(inputPath: string): string {
	// Expand tilde (~) to home directory
	const expanded = inputPath.startsWith('~')
		? path.join(homedir(), inputPath.slice(1))
		: inputPath;

	// Convert to absolute path
	return path.resolve(expanded);
}

/**
 * Get user-friendly error message for archive path issues
 * Provides helpful guidance for bunx users
 *
 * @param archivePath - The archive path that has issues
 * @param issue - Description of the issue
 * @returns Formatted error message with suggestions
 */
export function getArchivePathErrorMessage(archivePath: string, issue: string): string {
	const argv0 = process.argv[0] ?? '@ccusage/codex';
	return `
Archive path issue: ${issue}
  Path: ${archivePath}

To fix this:
  1. Specify a custom path with --path option:
     ${argv0.includes('bunx') ? 'bunx @ccusage/codex@latest' : '@ccusage/codex'} archive --path ~/my-archive

  2. Set environment variable:
     export CODEX_ARCHIVE_PATH=~/my-archive

  3. Create config file at ${CONFIG_FILE_PATH}:
     {
       "archive": {
         "codex": "~/my-archive"
       }
     }

For more help, see: https://github.com/yasunogithub/ccusage#archive
`.trim();
}

/**
 * Check if auto-archive is enabled
 * @returns true if auto-archive is enabled
 */
export function isAutoArchiveEnabled(): boolean {
	const config = loadConfig();
	return config.autoArchive ?? false;
}

/**
 * Get configuration file path for display/documentation
 * @returns Configuration file path
 */
export function getConfigFilePath(): string {
	return CONFIG_FILE_PATH;
}
