import { z } from 'zod';
import { argsToZodSchema } from './_args-to-zod.ts';
import { sharedArgs } from './_shared-args.ts';

// Import command definitions to access their args
import { blocksCommand } from './commands/blocks.ts';
import { dailyCommand } from './commands/daily.ts';
import { mcpCommand } from './commands/mcp.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { sessionCommand } from './commands/session.ts';
import { statuslineCommand } from './commands/statusline.ts';
import { weeklyCommand } from './commands/weekly.ts';

/**
 * Creates the complete configuration schema from all command definitions
 * @returns Zod schema for ccusage configuration file
 */
export function createConfigSchema(): z.ZodObject<any> {
	// Create schema for default/shared arguments
	const defaultsSchema = argsToZodSchema(sharedArgs);

	// Create schema for each command's specific arguments
	const commandsSchema = z.object({
		daily: argsToZodSchema(dailyCommand.args).optional(),
		monthly: argsToZodSchema(monthlyCommand.args).optional(),
		weekly: argsToZodSchema(weeklyCommand.args).optional(),
		session: argsToZodSchema(sessionCommand.args).optional(),
		blocks: argsToZodSchema(blocksCommand.args).optional(),
		mcp: argsToZodSchema(mcpCommand.args).optional(),
		statusline: argsToZodSchema(statuslineCommand.args).optional(),
	}).strict().optional(); // strict() prevents additional properties

	// Main configuration schema
	return z.object({
		$schema: z.string().optional().describe('JSON Schema URL for validation and autocomplete'),
		defaults: defaultsSchema.optional().describe('Default values for all commands'),
		commands: commandsSchema.describe('Command-specific configuration overrides'),
	});
}

/**
 * Type definition for configuration data
 */
export type ConfigData = z.infer<ReturnType<typeof createConfigSchema>>;

/**
 * Available command names
 */
export const COMMAND_NAMES = [
	'daily',
	'monthly',
	'weekly',
	'session',
	'blocks',
	'mcp',
	'statusline',
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('createConfigSchema', () => {
		it('should create valid config schema', () => {
			const schema = createConfigSchema();
			expect(schema).toBeDefined();

			// Test minimal valid config
			const minimalConfig = {};
			const result = schema.parse(minimalConfig);
			expect(result).toEqual({});
		});

		it('should accept $schema property', () => {
			const schema = createConfigSchema();
			const config = {
				$schema: 'https://example.com/schema.json',
			};
			const result = schema.parse(config);
			expect(result.$schema).toBe('https://example.com/schema.json');
		});

		it('should accept defaults configuration', () => {
			const schema = createConfigSchema();
			const config = {
				defaults: {
					json: true,
					mode: 'auto' as const,
					debug: false,
				},
			};
			const result = schema.parse(config);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.json).toBe(true);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.mode).toBe('auto');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.debug).toBe(false);
		});

		it('should accept command-specific configuration', () => {
			const schema = createConfigSchema();
			const config = {
				commands: {
					daily: {
						instances: true,
						project: 'my-project',
					},
					blocks: {
						active: true,
						tokenLimit: '500000',
					},
				},
			};
			const result = schema.parse(config);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.daily?.instances).toBe(true);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.daily?.project).toBe('my-project');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.blocks?.active).toBe(true);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.blocks?.tokenLimit).toBe('500000');
		});

		it('should accept complete configuration', () => {
			const schema = createConfigSchema();
			const config = {
				$schema: 'https://example.com/schema.json',
				defaults: {
					json: false,
					mode: 'calculate' as const,
					timezone: 'Asia/Tokyo',
					locale: 'ja-JP',
				},
				commands: {
					daily: {
						instances: true,
					},
					weekly: {
						startOfWeek: 'monday' as const,
					},
					blocks: {
						sessionLength: 6,
						tokenLimit: 'max',
					},
				},
			};
			const result = schema.parse(config);
			// Zod adds default values, so we check key properties instead of deep equality
			expect(result.$schema).toBe('https://example.com/schema.json');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.json).toBe(false);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.mode).toBe('calculate');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.timezone).toBe('Asia/Tokyo');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.defaults?.locale).toBe('ja-JP');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.daily?.instances).toBe(true);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.weekly?.startOfWeek).toBe('monday');
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.blocks?.sessionLength).toBe(6);
			// eslint-disable-next-line ts/no-unsafe-member-access
			expect(result.commands?.blocks?.tokenLimit).toBe('max');
		});

		it('should reject invalid enum values', () => {
			const schema = createConfigSchema();
			const config = {
				defaults: {
					mode: 'invalid-mode',
				},
			};
			expect(() => schema.parse(config)).toThrow();
		});

		it('should reject invalid command names', () => {
			const schema = createConfigSchema();
			const config = {
				commands: {
					invalidCommand: {
						someOption: true,
					},
				},
			};
			expect(() => schema.parse(config)).toThrow();
		});
	});
}
