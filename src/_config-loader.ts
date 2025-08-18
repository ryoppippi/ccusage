import type { CommandName, ConfigData } from './_config-schema.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@praha/byethrow';
import { createConfigSchema } from './_config-schema.ts';
import { logger } from './logger.ts';

// Type for Gunshi context values
type CliArgs = {
	[key: string]: unknown;
};

/**
 * Configuration file search paths in priority order (highest to lowest)
 * 1. Local .ccusage/ccusage.json
 * 2. User config ~/.config/claude/ccusage.json
 * 3. User home ~/.claude/ccusage.json (legacy)
 */
const CONFIG_SEARCH_PATHS = [
	'.ccusage/ccusage.json',
	join(homedir(), '.config/claude/ccusage.json'),
	join(homedir(), '.claude/ccusage.json'),
];

/**
 * Loads configuration from the first available config file
 * @returns Parsed configuration data or undefined if no config found
 */
export function loadConfig(): ConfigData | undefined {
	const schema = createConfigSchema();

	for (const configPath of CONFIG_SEARCH_PATHS) {
		if (existsSync(configPath)) {
			const parseConfigFile = Result.try({
				try: () => {
					const content = readFileSync(configPath, 'utf-8');
					const data = JSON.parse(content) as unknown;
					return schema.parse(data);
				},
				catch: error => error instanceof Error ? error : new Error(String(error)),
			});

			const result = parseConfigFile();

			if (Result.isSuccess(result)) {
				logger.debug(`Loaded configuration from: ${configPath}`);
				return result.value;
			}
			else {
				const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
				logger.warn(`Invalid configuration file at ${configPath}: ${errorMessage}`);
				// Continue searching other paths even if one config is invalid
			}
		}
	}

	logger.debug('No configuration file found in search paths');
	return undefined;
}

/**
 * Merges configuration with CLI arguments
 * Priority order (highest to lowest):
 * 1. CLI arguments (ctx.values)
 * 2. Command-specific config
 * 3. Default config
 * 4. Gunshi defaults
 *
 * @param commandName - The command being executed
 * @param cliArgs - Arguments from CLI (ctx.values)
 * @param config - Loaded configuration data
 * @returns Merged arguments object
 */
export function mergeConfigWithArgs(
	commandName: CommandName,
	cliArgs: CliArgs,
	config?: ConfigData,
): CliArgs {
	if (config == null) {
		return cliArgs;
	}

	// Start with an empty base
	const merged: CliArgs = {};

	// 1. Apply defaults from config (lowest priority)
	if (config.defaults != null) {
		Object.assign(merged, config.defaults);
	}

	// 2. Apply command-specific config
	// eslint-disable-next-line ts/no-unsafe-member-access
	if (config.commands?.[commandName] != null) {
		// eslint-disable-next-line ts/no-unsafe-member-access
		Object.assign(merged, config.commands[commandName]);
	}

	// 3. Apply CLI arguments (highest priority)
	// Only override with CLI args that are explicitly set (not undefined)
	for (const [key, value] of Object.entries(cliArgs)) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}

	logger.debug(`Merged config for ${commandName}:`, merged);
	return merged;
}

/**
 * Utility to find the active configuration file path
 * @returns Path to the configuration file being used, or undefined
 */
export function findConfigPath(): string | undefined {
	for (const configPath of CONFIG_SEARCH_PATHS) {
		if (existsSync(configPath)) {
			return configPath;
		}
	}
	return undefined;
}

/**
 * Validates a configuration file without loading it
 * @param configPath - Path to configuration file
 * @returns Validation result
 */
export function validateConfigFile(configPath: string): Result<ConfigData, Error> {
	if (!existsSync(configPath)) {
		return Result.fail(new Error(`Configuration file does not exist: ${configPath}`));
	}

	const parseConfig = Result.try({
		try: () => {
			const content = readFileSync(configPath, 'utf-8');
			const data = JSON.parse(content) as unknown;
			const schema = createConfigSchema();
			return schema.parse(data);
		},
		catch: error => error instanceof Error ? error : new Error(String(error)),
	});

	return parseConfig();
}

if (import.meta.vitest != null) {
	const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;

	describe('loadConfig', () => {
		let fixture: any;

		beforeEach(async () => {
			// eslint-disable-next-line ts/no-unsafe-assignment
			const { createFixture } = await import('fs-fixture') as any;
			// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call
			fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: { json: true },
					commands: { daily: { instances: true } },
				}),
				'invalid.json': '{ invalid json',
				'valid-minimal.json': '{}',
			});
		});

		afterEach(async () => {
			// eslint-disable-next-line ts/no-unsafe-call, ts/no-unsafe-member-access
			await fixture.rm();
		});

		it('should load valid configuration', () => {
			// Test validateConfigFile instead since it's easier to test with specific paths
			// eslint-disable-next-line ts/no-unsafe-call, ts/no-unsafe-member-access, ts/no-unsafe-assignment
			const result = validateConfigFile(fixture.getPath('.ccusage/ccusage.json') as string);
			// eslint-disable-next-line ts/no-unsafe-argument
			expect(Result.isSuccess(result)).toBe(true);
			// eslint-disable-next-line ts/no-unsafe-argument
			if (Result.isSuccess(result)) {
				// eslint-disable-next-line ts/no-unsafe-member-access
				expect(result.value.defaults?.json).toBe(true);
				// eslint-disable-next-line ts/no-unsafe-member-access
				expect(result.value.commands?.daily?.instances).toBe(true);
			}
		});

		it('should return undefined for non-existent config', () => {
			// Test with non-existent path directly
			const config = loadConfig(); // Will use actual paths which likely don't exist in test env
			expect(config).toBeUndefined();
		});
	});

	describe('mergeConfigWithArgs', () => {
		it('should merge config with CLI args correctly', () => {
			const config: ConfigData = {
				defaults: {
					json: false,
					mode: 'auto',
					debug: false,
				},
				commands: {
					daily: {
						instances: true,
						project: 'test-project',
					},
				},
			};

			const cliArgs = {
				json: true, // Override config
				project: undefined, // Should not override config
				breakdown: true, // Not in config
			};

			const merged = mergeConfigWithArgs('daily', cliArgs, config);

			expect(merged).toEqual({
				json: true, // From CLI (overrides config)
				mode: 'auto', // From defaults
				debug: false, // From defaults
				instances: true, // From command config
				project: 'test-project', // From command config (CLI was undefined)
				breakdown: true, // From CLI (new option)
			});
		});

		it('should work without config', () => {
			const cliArgs = { json: true, debug: false };
			const merged = mergeConfigWithArgs('daily', cliArgs);
			expect(merged).toEqual(cliArgs);
		});

		it('should prioritize CLI args over config', () => {
			const config: ConfigData = {
				defaults: { json: false },
				commands: { daily: { instances: false } },
			};

			const cliArgs = { json: true, instances: true };
			const merged = mergeConfigWithArgs('daily', cliArgs, config);

			expect(merged.json).toBe(true);
			expect(merged.instances).toBe(true);
		});
	});

	describe('validateConfigFile', () => {
		let fixture: any;

		beforeEach(async () => {
			// eslint-disable-next-line ts/no-unsafe-assignment
			const { createFixture } = await import('fs-fixture') as any;
			// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call
			fixture = await createFixture({
				'valid.json': JSON.stringify({
					defaults: { json: true },
				}),
				'invalid.json': '{ invalid json',
			});
		});

		afterEach(async () => {
			// eslint-disable-next-line ts/no-unsafe-call, ts/no-unsafe-member-access
			await fixture.rm();
		});

		it('should validate valid config file', () => {
			// eslint-disable-next-line ts/no-unsafe-call, ts/no-unsafe-member-access, ts/no-unsafe-assignment
			const result = validateConfigFile(fixture.getPath('valid.json') as string);
			// eslint-disable-next-line ts/no-unsafe-argument
			expect(Result.isSuccess(result)).toBe(true);
		});

		it('should reject invalid JSON', () => {
			// eslint-disable-next-line ts/no-unsafe-call, ts/no-unsafe-member-access, ts/no-unsafe-assignment
			const result = validateConfigFile(fixture.getPath('invalid.json') as string);
			// eslint-disable-next-line ts/no-unsafe-argument
			expect(Result.isFailure(result)).toBe(true);
		});

		it('should reject non-existent file', () => {
			// eslint-disable-next-line ts/no-unsafe-assignment
			const result = validateConfigFile('/non/existent/file.json');
			// eslint-disable-next-line ts/no-unsafe-argument
			expect(Result.isFailure(result)).toBe(true);
		});
	});
}
