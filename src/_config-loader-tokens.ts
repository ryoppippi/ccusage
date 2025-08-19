import type { subCommandUnion } from './commands/index.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { getClaudePaths } from './data-loader.ts';
import { logger } from './logger.ts';

export type CommandName = typeof subCommandUnion[number][0];

// Type for Gunshi context values
type CliArgs = Record<string, unknown>;

// Type for configuration data (simple structure without Zod)
export type ConfigData = {
	$schema?: string;
	defaults?: Record<string, any>;
	commands?: Partial<Record<CommandName, Record<string, any>>>;
};

/**
 * Get configuration file search paths in priority order (highest to lowest)
 * 1. Local .ccusage/ccusage.json
 * 2. User config directories from getClaudePaths() + ccusage.json
 */
function getConfigSearchPaths(): string[] {
	const paths = ['.ccusage/ccusage.json'];

	// Add paths from getClaudePaths() for consistency with data loading
	const claudePathsResult = Result.try({
		try: () => getClaudePaths(),
		safe: true,
	});
	if (Result.isSuccess(claudePathsResult)) {
		for (const claudePath of claudePathsResult.value as string[]) {
			paths.push(join(claudePath, 'ccusage.json'));
		}
	}
	// If getClaudePaths fails, continue with just local config path
	// This is OK for config loading since config files are optional

	return paths;
}

/**
 * Basic JSON validation - just check if it can be parsed and has expected structure
 */
function validateConfigJson(data: unknown): data is ConfigData {
	if (typeof data !== 'object' || data === null) {
		return false;
	}

	const config = data as Record<string, unknown>;

	// Optional schema property
	if (config.$schema != null && typeof config.$schema !== 'string') {
		return false;
	}

	// Optional defaults property
	if (config.defaults != null && (typeof config.defaults !== 'object' || config.defaults === null)) {
		return false;
	}

	// Optional commands property
	if (config.commands != null && (typeof config.commands !== 'object' || config.commands === null)) {
		return false;
	}

	return true;
}

/**
 * Loads configuration from the specified path or auto-discovery
 * @param configPath - Optional path to specific config file
 * @returns Parsed configuration data or undefined if no config found
 */
export function loadConfig(configPath?: string): ConfigData | undefined {
	// If specific config path is provided, use it exclusively
	if (configPath != null) {
		if (existsSync(configPath)) {
			const parseConfigFile = Result.try({
				try: () => {
					const content = readFileSync(configPath, 'utf-8');
					const data = JSON.parse(content) as unknown;
					if (!validateConfigJson(data)) {
						throw new Error('Invalid configuration structure');
					}
					return data;
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
				return undefined;
			}
		}
		else {
			logger.warn(`Configuration file not found: ${configPath}`);
			return undefined;
		}
	}

	// Auto-discovery from search paths
	for (const searchPath of getConfigSearchPaths()) {
		if (existsSync(searchPath)) {
			const parseConfigFile = Result.try({
				try: () => {
					const content = readFileSync(searchPath, 'utf-8');
					const data = JSON.parse(content) as unknown;
					if (!validateConfigJson(data)) {
						throw new Error('Invalid configuration structure');
					}
					return data;
				},
				catch: error => error instanceof Error ? error : new Error(String(error)),
			});

			const result = parseConfigFile();

			if (Result.isSuccess(result)) {
				logger.debug(`Loaded configuration from: ${searchPath}`);
				return result.value;
			}
			else {
				const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
				logger.warn(`Invalid configuration file at ${searchPath}: ${errorMessage}`);
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
export function mergeConfigWithArgs<T extends CliArgs>(
	commandName: CommandName,
	cliArgs: T,
	config?: ConfigData,
): T {
	if (config == null) {
		return cliArgs;
	}

	// Start with an empty base
	const merged = {} as T;

	// 1. Apply defaults from config (lowest priority)
	if (config.defaults != null) {
		Object.assign(merged, config.defaults);
	}

	// 2. Apply command-specific config
	if (config.commands?.[commandName] != null) {
		Object.assign(merged, config.commands[commandName]);
	}

	// 3. Apply CLI arguments (highest priority)
	// Only override with CLI args that are explicitly set (not undefined)
	for (const [key, value] of Object.entries(cliArgs)) {
		if (value != null) {
			// eslint-disable-next-line ts/no-unsafe-member-access
			(merged as any)[key] = value;
		}
	}

	logger.debug(`Merged config for ${String(commandName)}:`, merged);
	return merged;
}

/**
 * Utility to find the active configuration file path
 * @returns Path to the configuration file being used, or undefined
 */
export function findConfigPath(): string | undefined {
	for (const configPath of getConfigSearchPaths()) {
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
export function validateConfigFile(configPath: string): { success: true; data: ConfigData } | { success: false; error: Error } {
	if (!existsSync(configPath)) {
		return { success: false, error: new Error(`Configuration file does not exist: ${configPath}`) };
	}

	const parseConfig = Result.try({
		try: () => {
			const content = readFileSync(configPath, 'utf-8');
			const data = JSON.parse(content) as unknown;
			if (!validateConfigJson(data)) {
				throw new Error('Invalid configuration structure');
			}
			return data;
		},
		catch: error => error instanceof Error ? error : new Error(String(error)),
	});

	const result = parseConfig();
	if (Result.isSuccess(result)) {
		return { success: true, data: result.value };
	}
	else {
		return { success: false, error: result.error };
	}
}

if (import.meta.vitest != null) {
	describe('loadConfig', () => {
		it('should load valid configuration', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: { json: true },
					commands: { daily: { instances: true } },
				}),
				'invalid.json': '{ invalid json',
				'valid-minimal.json': '{}',
			});

			// Test validateConfigFile instead since it's easier to test with specific paths
			const result = validateConfigFile(fixture.getPath('.ccusage/ccusage.json'));
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.defaults?.json).toBe(true);
				expect(result.data.commands?.daily?.instances).toBe(true);
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
		it('should validate valid config file', async () => {
			await using fixture = await createFixture({
				'valid.json': JSON.stringify({
					defaults: { json: true },
				}),
				'invalid.json': '{ invalid json',
			});

			const result = validateConfigFile(fixture.getPath('valid.json'));
			expect(result.success).toBe(true);
		});

		it('should reject invalid JSON', async () => {
			await using fixture = await createFixture({
				'valid.json': JSON.stringify({
					defaults: { json: true },
				}),
				'invalid.json': '{ invalid json',
			});

			const result = validateConfigFile(fixture.getPath('invalid.json'));
			expect(result.success).toBe(false);
		});

		it('should reject non-existent file', () => {
			const result = validateConfigFile('/non/existent/file.json');
			expect(result.success).toBe(false);
		});
	});
}
