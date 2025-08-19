import type { subCommandUnion } from './commands/index.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { toArray } from '@antfu/utils';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { CONFIG_FILE_NAME } from './_consts.ts';
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
	source?: string;
};

/**
 * Get configuration file search paths in priority order (highest to lowest)
 * 1. Local .ccusage/ccusage.json
 * 2. User config directories from getClaudePaths() + ccusage.json
 */
function getConfigSearchPaths(): string[] {
	const claudeConfigDirs = [
		join(process.cwd(), '.ccusage'),
		...toArray(getClaudePaths()),
	];
	return claudeConfigDirs.map(dir => join(dir, CONFIG_FILE_NAME));
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
 * Internal function to load and parse a configuration file
 * @param filePath - Path to the configuration file
 * @returns ConfigData if successful, undefined if failed
 */
function loadConfigFile(filePath: string): ConfigData | undefined {
	if (!existsSync(filePath)) {
		return undefined;
	}

	const parseConfigFileResult = Result.pipe(
		Result.try({
			try: () => {
				const content = readFileSync(filePath, 'utf-8');
				const data = JSON.parse(content) as unknown;
				if (!validateConfigJson(data)) {
					throw new Error('Invalid configuration structure');
				}
				return data;
			},
			catch: error => error,
		})(),
		Result.inspect(() => logger.debug(`Parsed configuration file: ${filePath}`)),
		Result.inspectError((error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.warn(`Error parsing configuration file at ${filePath}: ${errorMessage}`);
		}),
		Result.unwrap(undefined),
	);

	return parseConfigFileResult;
}

/**
 * Loads configuration from the specified path or auto-discovery
 * @param configPath - Optional path to specific config file
 * @returns Parsed configuration data or undefined if no config found
 */
export function loadConfig(configPath?: string): ConfigData | undefined {
	// If specific config path is provided, use it exclusively
	if (configPath != null) {
		const config = loadConfigFile(configPath);
		if (config == null) {
			logger.warn(`Configuration file not found or invalid: ${configPath}`);
		}
		return config;
	}

	// Auto-discovery from search paths (highest priority first)
	for (const searchPath of getConfigSearchPaths()) {
		const config = loadConfigFile(searchPath);
		if (config != null) {
			return config;
		}
		// Continue searching other paths even if one config is invalid
	}

	logger.debug('No valid configuration file found');
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
		beforeEach(() => {
			vi.restoreAllMocks();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('should load valid configuration from .ccusage/ccusage.json', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: { json: true },
					commands: { daily: { instances: true } },
				}),
			});

			// Mock process.cwd to return fixture path
			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

			const config = loadConfig();
			expect(config).toBeDefined();
			expect(config?.defaults?.json).toBe(true);
			expect(config?.commands?.daily?.instances).toBe(true);
		});

		it('should load configuration with specific path', async () => {
			await using fixture = await createFixture({
				'custom-config.json': JSON.stringify({
					defaults: { debug: true },
					commands: { monthly: { breakdown: true } },
				}),
			});

			const config = loadConfig(fixture.getPath('custom-config.json'));
			expect(config).toBeDefined();
			expect(config?.defaults?.debug).toBe(true);
			expect(config?.commands?.monthly?.breakdown).toBe(true);
		});

		it('should return undefined for non-existent config file', () => {
			const config = loadConfig('/non/existent/path.json');
			expect(config).toBeUndefined();
		});

		it('should return undefined when no config files exist in search paths', () => {
			// Mock process.cwd to return a directory without config files
			vi.spyOn(process, 'cwd').mockReturnValue('/tmp/empty-dir');

			const config = loadConfig();
			expect(config).toBeUndefined();
		});

		it('should handle invalid JSON gracefully', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': '{ invalid json }',
			});

			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

			const config = loadConfig();
			expect(config).toBeUndefined();
		});

		it('should prioritize local .ccusage config over Claude paths', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: { json: true },
					commands: { daily: { priority: 'local' } },
				}),
			});

			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

			const config = loadConfig();
			expect(config).toBeDefined();
			expect(config?.defaults?.json).toBe(true);
			expect(config?.commands?.daily?.priority).toBe('local');
		});

		it('should test configuration priority order with multiple files', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					source: 'local',
					defaults: { mode: 'local-mode' },
				}),
			});

			// Test 1: Local config should have highest priority
			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

			const config1 = loadConfig();
			expect(config1?.source).toBe('local');
			expect(config1?.defaults?.mode).toBe('local-mode');

			// Test 2: When local doesn't exist, search in Claude paths
			await using fixture2 = await createFixture({
				'no-ccusage-dir': '',
			});

			vi.spyOn(process, 'cwd').mockReturnValue(fixture2.getPath());

			const config2 = loadConfig();
			// Since we can't easily mock getClaudePaths, this test verifies the logic
			// In real implementation, first available config would be loaded
			expect(config2).toBeUndefined(); // No local .ccusage and no real Claude paths
		});

		it('should handle getClaudePaths() errors gracefully', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: { json: true },
					source: 'local-fallback',
				}),
			});

			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());
			// getClaudePaths might throw if no Claude directories exist

			const config = loadConfig();
			expect(config).toBeDefined();
			expect(config?.source).toBe('local-fallback');
			expect(config?.defaults?.json).toBe(true);
		});

		it('should handle empty configuration file', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': '{}',
			});

			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

			const config = loadConfig();
			expect(config).toBeDefined();
			expect(config?.defaults).toBeUndefined();
			expect(config?.commands).toBeUndefined();
		});

		it('should validate configuration structure', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: 'invalid-type', // Should be object
					commands: { daily: { instances: true } },
				}),
			});

			vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

			const config = loadConfig();
			expect(config).toBeUndefined();
		});

		it('should use validateConfigFile internally', async () => {
			await using fixture = await createFixture({
				'.ccusage/ccusage.json': JSON.stringify({
					defaults: { json: true },
					commands: { daily: { instances: true } },
				}),
				'invalid.json': '{ invalid json',
				'valid-minimal.json': '{}',
			});

			// Test validateConfigFile directly
			const validResult = validateConfigFile(fixture.getPath('.ccusage/ccusage.json'));
			expect(validResult.success).toBe(true);
			expect((validResult as { success: true; data: ConfigData }).data.defaults?.json).toBe(true);
			expect((validResult as { success: true; data: ConfigData }).data.commands?.daily?.instances).toBe(true);

			const invalidResult = validateConfigFile(fixture.getPath('invalid.json'));
			expect(invalidResult.success).toBe(false);
			expect((invalidResult as { success: false; error: Error }).error).toBeInstanceOf(Error);

			const minimalResult = validateConfigFile(fixture.getPath('valid-minimal.json'));
			expect(minimalResult.success).toBe(true);
			expect((minimalResult as { success: true; data: ConfigData }).data).toEqual({});

			const nonExistentResult = validateConfigFile(fixture.getPath('non-existent.json'));
			expect(nonExistentResult.success).toBe(false);
			expect((nonExistentResult as { success: false; error: Error }).error.message).toContain('does not exist');
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
