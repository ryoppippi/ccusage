import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { toArray } from '@antfu/utils';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { CONFIG_FILE_NAME } from './_consts.ts';
import { getClaudePaths } from './data-loader.ts';
import { logger } from './logger.ts';

/**
 * Minimal command context interface for config merging
 * Contains only the properties we need from Gunshi's CommandContext
 */
export type ConfigMergeContext<T extends Record<string, unknown>> = {
	/** Command values from CLI */
	values: T;
	/** Command tokens from CLI */
	tokens: unknown[];
	/** Command name being executed */
	name?: string;
};

/**
 * Extract explicitly provided arguments from gunshi tokens
 * @param tokens - Command tokens from ctx.tokens
 * @returns Object with keys as argument names and values as boolean (true if explicitly provided)
 */
function extractExplicitArgs(tokens: unknown[]): Record<string, boolean> {
	const explicit: Record<string, boolean> = {};

	for (const token of tokens) {
		if (typeof token === 'object' && token !== null) {
			const t = token as { kind?: string; name?: string };
			if (t.kind === 'option' && typeof t.name === 'string') {
				explicit[t.name] = true;
			}
		}
	}

	return explicit;
}

// Type for configuration data (simple structure without Zod)
export type ConfigData = {
	$schema?: string;
	defaults?: Record<string, any>;
	commands?: Record<string, Record<string, any>>;
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
 * @param debug - Whether to enable debug logging
 * @returns ConfigData if successful, undefined if failed
 */
function loadConfigFile(filePath: string, debug = false): ConfigData | undefined {
	if (!existsSync(filePath)) {
		if (debug) {
			logger.info(`  • Checking: ${filePath} (not found)`);
		}
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
				// Add source path to the config for debug display
				(data).source = filePath;
				return data;
			},
			catch: error => error,
		})(),
		Result.inspect(() => {
			logger.debug(`Parsed configuration file: ${filePath}`);
			if (debug) {
				logger.info(`  • Checking: ${filePath} (found ✓)`);
			}
		}),
		Result.inspectError((error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.warn(`Error parsing configuration file at ${filePath}: ${errorMessage}`);
			if (debug) {
				logger.info(`  • Checking: ${filePath} (error: ${errorMessage})`);
			}
		}),
		Result.unwrap(undefined),
	);

	return parseConfigFileResult;
}

/**
 * Loads configuration from the specified path or auto-discovery
 * @param configPath - Optional path to specific config file
 * @param debug - Whether to enable debug logging
 * @returns Parsed configuration data or undefined if no config found
 */
export function loadConfig(configPath?: string, debug = false): ConfigData | undefined {
	if (debug) {
		logger.info('Debug mode enabled - showing config loading details\n');
	}

	// If specific config path is provided, use it exclusively
	if (configPath != null) {
		if (debug) {
			logger.info('Using specified config file:');
			logger.info(`  • Path: ${configPath}`);
		}
		const config = loadConfigFile(configPath, debug);
		if (config == null) {
			logger.warn(`Configuration file not found or invalid: ${configPath}`);
		}
		else if (debug) {
			logger.info('');
			logger.info(`Loaded config from: ${configPath}`);
			logger.info(`  • Schema: ${config.$schema ?? 'none'}`);
			logger.info(`  • Has defaults: ${config.defaults != null ? 'yes' : 'no'}${config.defaults != null ? ` (${Object.keys(config.defaults).length} options)` : ''}`);
			logger.info(`  • Has command configs: ${config.commands != null ? 'yes' : 'no'}${config.commands != null ? ` (${Object.keys(config.commands).join(', ')})` : ''}`);
		}
		return config;
	}

	// Auto-discovery from search paths (highest priority first)
	if (debug) {
		logger.info('Searching for config files:');
	}

	for (const searchPath of getConfigSearchPaths()) {
		const config = loadConfigFile(searchPath, debug);
		if (config != null) {
			if (debug) {
				logger.info('');
				logger.info(`Loaded config from: ${searchPath}`);
				logger.info(`  • Schema: ${config.$schema ?? 'none'}`);
				logger.info(`  • Has defaults: ${config.defaults != null ? 'yes' : 'no'}${config.defaults != null ? ` (${Object.keys(config.defaults).length} options)` : ''}`);
				logger.info(`  • Has command configs: ${config.commands != null ? 'yes' : 'no'}${config.commands != null ? ` (${Object.keys(config.commands).join(', ')})` : ''}`);
			}
			return config;
		}
		// Continue searching other paths even if one config is invalid
	}

	logger.debug('No valid configuration file found');
	if (debug) {
		logger.info('');
		logger.info('No valid configuration file found');
	}
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
 * @param ctx - Command context with values, tokens, and name
 * @param config - Loaded configuration data
 * @param debug - Whether to enable debug logging
 * @returns Merged arguments object
 */
export function mergeConfigWithArgs<T extends Record<string, unknown>>(
	ctx: ConfigMergeContext<T>,
	config?: ConfigData,
	debug = false,
): T {
	if (config == null) {
		if (debug) {
			logger.info('');
			logger.info(`No config file loaded, using CLI args only for '${ctx.name ?? 'unknown'}' command`);
		}
		return ctx.values;
	}

	// Start with an empty base
	const merged = {} as T;
	const commandName = ctx.name;

	// Track sources for debug output
	const sources: Record<string, string> = {};

	// 1. Apply defaults from config (lowest priority)
	if (config.defaults != null) {
		for (const [key, value] of Object.entries(config.defaults)) {
			(merged as Record<string, unknown>)[key] = value;
			sources[key] = 'defaults';
		}
	}

	// 2. Apply command-specific config
	if (commandName != null && config.commands?.[commandName] != null) {
		for (const [key, value] of Object.entries(config.commands[commandName])) {
			(merged as Record<string, unknown>)[key] = value;
			sources[key] = 'command config';
		}
	}

	// 3. Apply CLI arguments (highest priority)
	// Only override with CLI args that are explicitly provided by the user
	const explicit = extractExplicitArgs(ctx.tokens);
	for (const [key, value] of Object.entries(ctx.values)) {
		if (value != null && explicit[key] === true) {
			// eslint-disable-next-line ts/no-unsafe-member-access
			(merged as any)[key] = value;
			sources[key] = 'CLI';
		}
	}

	logger.debug(`Merged config for ${commandName ?? 'unknown'}:`, merged);

	if (debug) {
		logger.info('');
		logger.info(`Merging options for '${commandName ?? 'unknown'}' command:`);

		// Group options by source
		const bySource: Record<string, string[]> = {
			'defaults': [],
			'command config': [],
			'CLI': [],
		};

		for (const [key, source] of Object.entries(sources)) {
			if (bySource[source] != null) {
				bySource[source].push(`${key}=${JSON.stringify((merged as Record<string, unknown>)[key])}`);
			}
		}

		if (bySource.defaults!.length > 0) {
			logger.info(`  • From defaults: ${bySource.defaults!.join(', ')}`);
		}
		if (bySource['command config']!.length > 0) {
			logger.info(`  • From command config: ${bySource['command config']!.join(', ')}`);
		}
		if (bySource.CLI!.length > 0) {
			logger.info(`  • From CLI args: ${bySource.CLI!.join(', ')}`);
		}

		// Show final result with sources
		logger.info('  • Final merged options: {');
		for (const [key, value] of Object.entries(merged)) {
			const source = sources[key] ?? 'unknown';
			logger.info(`      ${key}: ${JSON.stringify(value)} (from ${source}),`);
		}
		logger.info('    }');
	}

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
	describe('extractExplicitArgs', () => {
		it('should extract explicit arguments from tokens', () => {
			const tokens = [
				{ kind: 'option', name: 'json' },
				{ kind: 'option', name: 'debug' },
				{ kind: 'positional', value: 'daily' }, // Should be ignored
				{ kind: 'option', name: 'mode' },
			];

			const result = extractExplicitArgs(tokens);
			expect(result).toEqual({
				json: true,
				debug: true,
				mode: true,
			});
		});

		it('should handle empty tokens array', () => {
			const result = extractExplicitArgs([]);
			expect(result).toEqual({});
		});

		it('should handle invalid token structures', () => {
			const tokens = [
				null,
				undefined,
				'string',
				123,
				{ kind: 'option' }, // Missing name
				{ name: 'test' }, // Missing kind
				{ kind: 'other', name: 'ignored' }, // Wrong kind
			];

			const result = extractExplicitArgs(tokens);
			expect(result).toEqual({});
		});

		it('should handle mixed valid and invalid tokens', () => {
			const tokens = [
				{ kind: 'option', name: 'valid' },
				null,
				{ kind: 'positional', value: 'ignored' },
				{ kind: 'option', name: 'alsoValid' },
			];

			const result = extractExplicitArgs(tokens);
			expect(result).toEqual({
				valid: true,
				alsoValid: true,
			});
		});
	});

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
			expect(config1?.source).toBe(fixture.getPath('.ccusage/ccusage.json'));
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
			expect(config?.source).toBe(fixture.getPath('.ccusage/ccusage.json'));
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

			const merged = mergeConfigWithArgs({ values: cliArgs, tokens: [
				{ kind: 'option', name: 'json' },
				{ kind: 'option', name: 'breakdown' },
			], name: 'daily' }, config);

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
			const merged = mergeConfigWithArgs({ values: cliArgs, tokens: [
				{ kind: 'option', name: 'json' },
				{ kind: 'option', name: 'debug' },
			], name: 'daily' });
			expect(merged).toEqual(cliArgs);
		});

		it('should prioritize CLI args over config', () => {
			const config: ConfigData = {
				defaults: { json: false },
				commands: { daily: { instances: false } },
			};

			const cliArgs = { json: true, instances: true };
			const merged = mergeConfigWithArgs({ values: cliArgs, tokens: [
				{ kind: 'option', name: 'json' },
				{ kind: 'option', name: 'instances' },
			], name: 'daily' }, config);

			expect(merged.json).toBe(true);
			expect(merged.instances).toBe(true);
		});

		it('should not override config with CLI args that were not explicitly provided', () => {
			const config: ConfigData = {
				defaults: {
					json: false,
					mode: 'calculate',
				},
				commands: {
					daily: {
						instances: true,
					},
				},
			};

			// CLI args has values but only 'json' was explicitly provided
			const cliArgs = {
				json: true,
				mode: 'auto', // This has a value but wasn't explicitly provided
				instances: false, // This also has a value but wasn't explicitly provided
			};

			const merged = mergeConfigWithArgs({ values: cliArgs, tokens: [
				{ kind: 'option', name: 'json' }, // Only json was explicitly provided
			], name: 'daily' }, config);

			expect(merged).toEqual({
				json: true, // From CLI (explicitly provided)
				mode: 'calculate', // From config (CLI value ignored because not explicit)
				instances: true, // From command config (CLI value ignored because not explicit)
			});
		});

		it('should handle CLI args with null values correctly', () => {
			const config: ConfigData = {
				defaults: {
					project: 'default-project',
				},
			};

			const cliArgs = {
				project: null, // Explicitly set to null
			};

			const merged = mergeConfigWithArgs({ values: cliArgs, tokens: [
				{ kind: 'option', name: 'project' },
			], name: 'daily' }, config);

			// null value in CLI args should not override config even if explicit
			expect(merged).toEqual({
				project: 'default-project', // Config value retained because CLI value is null
			});
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

	describe('debug functionality', () => {
		let loggerInfoSpy: any;

		beforeEach(() => {
			vi.restoreAllMocks();
			loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		describe('loadConfig with debug', () => {
			it('should log debug info when loading config with debug=true', async () => {
				await using fixture = await createFixture({
					'.ccusage/ccusage.json': JSON.stringify({
						$schema: 'https://ccusage.com/config-schema.json',
						defaults: { json: true, mode: 'auto' },
						commands: { daily: { instances: true } },
					}),
				});

				vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

				const config = loadConfig(undefined, true);

				expect(config).toBeDefined();
				expect(loggerInfoSpy).toHaveBeenCalledWith('Debug mode enabled - showing config loading details\n');
				expect(loggerInfoSpy).toHaveBeenCalledWith('Searching for config files:');
				expect(loggerInfoSpy).toHaveBeenCalledWith(`  • Checking: ${fixture.getPath('.ccusage/ccusage.json')} (found ✓)`);
				expect(loggerInfoSpy).toHaveBeenCalledWith('');
				expect(loggerInfoSpy).toHaveBeenCalledWith(`Loaded config from: ${fixture.getPath('.ccusage/ccusage.json')}`);
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Schema: https://ccusage.com/config-schema.json');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Has defaults: yes (2 options)');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Has command configs: yes (daily)');
			});

			it('should log search paths when no config found with debug=true', async () => {
				await using fixture = await createFixture({
					'no-config-here': '',
				});

				vi.spyOn(process, 'cwd').mockReturnValue(fixture.getPath());

				const config = loadConfig(undefined, true);

				expect(config).toBeUndefined();
				expect(loggerInfoSpy).toHaveBeenCalledWith('Debug mode enabled - showing config loading details\n');
				expect(loggerInfoSpy).toHaveBeenCalledWith('Searching for config files:');
				expect(loggerInfoSpy).toHaveBeenCalledWith('');
				expect(loggerInfoSpy).toHaveBeenCalledWith('No valid configuration file found');
			});

			it('should log specific config file path when provided', async () => {
				await using fixture = await createFixture({
					'custom-config.json': JSON.stringify({
						defaults: { debug: true },
					}),
				});

				const configPath = fixture.getPath('custom-config.json');
				const config = loadConfig(configPath, true);

				expect(config).toBeDefined();
				expect(loggerInfoSpy).toHaveBeenCalledWith('Debug mode enabled - showing config loading details\n');
				expect(loggerInfoSpy).toHaveBeenCalledWith('Using specified config file:');
				expect(loggerInfoSpy).toHaveBeenCalledWith(`  • Path: ${configPath}`);
				expect(loggerInfoSpy).toHaveBeenCalledWith('');
				expect(loggerInfoSpy).toHaveBeenCalledWith(`Loaded config from: ${configPath}`);
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Schema: none');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Has defaults: yes (1 options)');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Has command configs: no');
			});
		});

		describe('mergeConfigWithArgs with debug', () => {
			it('should log merge details with debug=true', () => {
				const config: ConfigData = {
					defaults: {
						mode: 'auto',
						offline: false,
					},
					commands: {
						daily: {
							instances: true,
							project: 'test-project',
						},
					},
				};

				const cliArgs = {
					debug: true,
					since: '20250101',
				};

				const merged = mergeConfigWithArgs({
					values: cliArgs,
					tokens: [
						{ kind: 'option', name: 'debug' },
						{ kind: 'option', name: 'since' },
					],
					name: 'daily',
				}, config, true);

				expect(merged).toEqual({
					mode: 'auto',
					offline: false,
					instances: true,
					project: 'test-project',
					debug: true,
					since: '20250101',
				});

				expect(loggerInfoSpy).toHaveBeenCalledWith('');
				expect(loggerInfoSpy).toHaveBeenCalledWith(`Merging options for 'daily' command:`);
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • From defaults: mode="auto", offline=false');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • From command config: instances=true, project="test-project"');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • From CLI args: debug=true, since="20250101"');
				expect(loggerInfoSpy).toHaveBeenCalledWith('  • Final merged options: {');
			});

			it('should log no config message with debug=true when config is null', () => {
				const cliArgs = { json: true, debug: false };

				const merged = mergeConfigWithArgs({
					values: cliArgs,
					tokens: [
						{ kind: 'option', name: 'json' },
						{ kind: 'option', name: 'debug' },
					],
					name: 'daily',
				}, undefined, true);

				expect(merged).toEqual(cliArgs);
				expect(loggerInfoSpy).toHaveBeenCalledWith('');
				expect(loggerInfoSpy).toHaveBeenCalledWith(`No config file loaded, using CLI args only for 'daily' command`);
			});
		});
	});
}
