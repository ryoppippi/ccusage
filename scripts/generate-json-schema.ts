#!/usr/bin/env bun

/**
 * @fileoverview Generate JSON Schema from args-tokens configuration schema
 *
 * This script generates a JSON Schema file from the args-tokens configuration schema
 * for ccusage configuration files. The generated schema enables:
 * - IDE autocomplete and validation
 * - Documentation of available options
 * - Schema validation for configuration files
 */

import process from 'node:process';
import { Result } from '@praha/byethrow';
import { $ } from 'bun';
import { sharedArgs } from '../src/_shared-args.ts';
// Import command definitions to access their args
import { subCommandUnion } from '../src/commands/index.ts';

import { logger } from '../src/logger.ts';

/**
 * The filename for the generated JSON Schema file.
 * Used for both root directory and docs/public directory output.
 */
const SCHEMA_FILENAME = 'config-schema.json';

/**
 * Keys to exclude from the generated JSON Schema.
 * These are CLI-only options that shouldn't appear in configuration files.
 */
const EXCLUDE_KEYS = ['config'];

/**
 * Command-specific keys to exclude from the generated JSON Schema.
 * These are CLI-only options that shouldn't appear in configuration files.
 */
const COMMAND_EXCLUDE_KEYS: Record<string, string[]> = {
	blocks: ['live', 'refreshInterval'],
};

/**
 * Convert args-tokens schema to JSON Schema format
 */
function tokensSchemaToJsonSchema(schema: Record<string, any>): Record<string, any> {
	const properties: Record<string, any> = {};

	for (const [key, arg] of Object.entries(schema)) {
		// eslint-disable-next-line ts/no-unsafe-assignment
		const argTyped = arg;
		const property: Record<string, any> = {};

		// Handle type conversion
		// eslint-disable-next-line ts/no-unsafe-member-access
		switch (argTyped.type) {
			case 'boolean':
				property.type = 'boolean';
				break;
			case 'number':
				property.type = 'number';
				break;
			case 'string':
			case 'custom':
				property.type = 'string';
				break;
			case 'enum':
				property.type = 'string';
				// eslint-disable-next-line ts/no-unsafe-member-access
				if (argTyped.choices != null && Array.isArray(argTyped.choices)) {
					// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-member-access
					property.enum = argTyped.choices;
				}
				break;
			default:
				property.type = 'string';
		}

		// Add description
		// eslint-disable-next-line ts/no-unsafe-member-access
		if (argTyped.description != null) {
			// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-member-access
			property.description = argTyped.description;
			// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-member-access
			property.markdownDescription = argTyped.description;
		}

		// Add default value
		// eslint-disable-next-line ts/no-unsafe-member-access
		if ('default' in argTyped && argTyped.default !== undefined) {
			// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-member-access
			property.default = argTyped.default;
		}

		properties[key] = property;
	}

	return {
		type: 'object',
		properties,
		additionalProperties: false,
	};
}

/**
 * Create the complete configuration schema from all command definitions
 */
function createConfigSchemaJson() {
	// Create schema for default/shared arguments (excluding CLI-only options)
	const defaultsSchema = Object.fromEntries(
		Object.entries(sharedArgs).filter(([key]) => !EXCLUDE_KEYS.includes(key)),
	);

	// Create schemas for each command's specific arguments (excluding CLI-only options)
	const commandSchemas: Record<string, any> = {};
	for (const [commandName, command] of subCommandUnion) {
		const commandExcludes = COMMAND_EXCLUDE_KEYS[commandName] ?? [];
		commandSchemas[commandName] = Object.fromEntries(
			Object.entries(command.args as Record<string, any>).filter(([key]) =>
				!EXCLUDE_KEYS.includes(key) && !commandExcludes.includes(key),
			),
		);
	}

	// Convert to JSON Schema format

	const defaultsJsonSchema = tokensSchemaToJsonSchema(defaultsSchema);
	const commandsJsonSchema = {
		type: 'object',
		properties: Object.fromEntries(
			Object.entries(commandSchemas).map(([name, schema]) => [
				name,
				// eslint-disable-next-line ts/no-unsafe-argument
				tokensSchemaToJsonSchema(schema),
			]),
		),
		additionalProperties: false,
		description: 'Command-specific configuration overrides',
		markdownDescription: 'Command-specific configuration overrides',
	};

	// Main configuration schema
	return {
		$ref: '#/definitions/ccusage-config',
		definitions: {
			'ccusage-config': {
				type: 'object',
				properties: {
					$schema: {
						type: 'string',
						description: 'JSON Schema URL for validation and autocomplete',
						markdownDescription: 'JSON Schema URL for validation and autocomplete',
					},
					defaults: {
						...(defaultsJsonSchema),
						description: 'Default values for all commands',
						markdownDescription: 'Default values for all commands',
					},
					commands: commandsJsonSchema,
				},
				additionalProperties: false,
			},
		},
		$schema: 'https://json-schema.org/draft-07/schema#',
		title: 'ccusage Configuration',
		description: 'Configuration file for ccusage - Claude Code usage analysis tool',
		examples: [
			{
				$schema: 'https://ccusage.com/config-schema.json',
				defaults: {
					json: false,
					mode: 'auto',
					timezone: 'Asia/Tokyo',
					locale: 'ja-JP',
				},
				commands: {
					daily: {
						instances: true,
					},
					blocks: {
						tokenLimit: '500000',
					},
				},
			},
		],
	};
}

/**
 * Generate JSON Schema and write to files
 */
async function runLint(files: string[]) {
	return Result.try({
		try: $`bun run lint --fix ${files}`,
		catch: error => error,
	});
}

async function writeFile(path: string, content: string) {
	const attempt = Result.try({
		try: async () => Bun.write(path, content),
		catch: error => error,
	});
	return attempt();
}

async function readFile(path: string): Promise<Result.Result<string, any>> {
	return Result.try({
		try: async () => {
			const file = Bun.file(path);
			return file.text();
		},
		catch: error => error,
	})();
}

async function copySchemaToDocsPublic() {
	return Result.pipe(
		Result.try({
			try: $`cp ${SCHEMA_FILENAME} docs/public/${SCHEMA_FILENAME}`,
			catch: error => error,
		}),
		Result.inspectError((error) => {
			logger.error(`Failed to copy to docs/public/${SCHEMA_FILENAME}:`, error);
			process.exit(1);
		}),
		Result.inspect(() => logger.info(`✓ Copied to docs/public/${SCHEMA_FILENAME}`)),
	);
}

async function generateJsonSchema() {
	logger.info('Generating JSON Schema from args-tokens configuration schema...');

	// Create the JSON Schema
	const schemaObject = Result.pipe(
		Result.try({
			try: () => createConfigSchemaJson(),
			catch: error => error,
		})(),
		Result.inspectError((error) => {
			logger.error('Error creating JSON Schema:', error);
			process.exit(1);
		}),
		Result.unwrap(),
	);

	// Check if existing root schema is identical to avoid unnecessary writes
	const existingRootSchema = await Result.pipe(
		readFile(SCHEMA_FILENAME),
		Result.map(content => JSON.parse(content) as unknown),
		Result.unwrap(''),
	);

	const isSchemaChanged = !Bun.deepEquals(existingRootSchema, schemaObject, true);

	if (!isSchemaChanged) {
		logger.info('✓ Root schema is up to date, skipping generation');

		// Always copy to docs/public since it's gitignored
		await copySchemaToDocsPublic();

		logger.info('JSON Schema sync completed successfully!');
		return;
	}

	const schemaJson = JSON.stringify(schemaObject, null, '\t');

	await Result.pipe(
		Result.try({
			try: writeFile(SCHEMA_FILENAME, schemaJson),
			safe: true,
		}),
		Result.inspectError((error) => {
			logger.error(`Failed to write ${SCHEMA_FILENAME}:`, error);
			process.exit(1);
		}),
		Result.inspect(() => logger.info(`✓ Generated ${SCHEMA_FILENAME}`)),
	);

	// Copy to docs/public using Bun shell
	await copySchemaToDocsPublic();

	// Run lint on the root schema file that was changed
	await Result.pipe(
		Result.try({
			try: runLint([SCHEMA_FILENAME]),
			safe: true,
		}),
		Result.inspectError((error) => {
			logger.error('Failed to lint generated files:', error);
			process.exit(1);
		}),
		Result.inspect(() => logger.info('✓ Linted generated files')),
	);

	logger.info('JSON Schema generation completed successfully!');
}

// Run the generator
if (import.meta.main) {
	await generateJsonSchema();
}
if (import.meta.vitest != null) {
	describe('tokensSchemaToJsonSchema', () => {
		it('should convert boolean args to JSON Schema', () => {
			const schema = {
				debug: {
					type: 'boolean',
					description: 'Enable debug mode',
					default: false,
				},
			};

			const jsonSchema = tokensSchemaToJsonSchema(schema);
			expect((jsonSchema.properties as Record<string, any>).debug).toEqual({
				type: 'boolean',
				description: 'Enable debug mode',
				markdownDescription: 'Enable debug mode',
				default: false,
			});
		});

		it('should convert enum args to JSON Schema', () => {
			const schema = {
				mode: {
					type: 'enum',
					description: 'Mode selection',
					choices: ['auto', 'manual'],
					default: 'auto',
				},
			};

			const jsonSchema = tokensSchemaToJsonSchema(schema);
			expect((jsonSchema.properties as Record<string, any>).mode).toEqual({
				type: 'string',
				enum: ['auto', 'manual'],
				description: 'Mode selection',
				markdownDescription: 'Mode selection',
				default: 'auto',
			});
		});
	});

	describe('createConfigSchemaJson', () => {
		it('should generate valid JSON Schema', () => {
			const jsonSchema = createConfigSchemaJson();

			expect(jsonSchema).toBeDefined();
			expect(jsonSchema.$ref).toBe('#/definitions/ccusage-config');
			expect(jsonSchema.definitions).toBeDefined();
			expect(jsonSchema.definitions['ccusage-config']).toBeDefined();
			expect(jsonSchema.definitions['ccusage-config'].type).toBe('object');
		});

		it('should include all expected properties', () => {
			const jsonSchema = createConfigSchemaJson();
			const mainSchema = jsonSchema.definitions['ccusage-config'];

			expect(mainSchema.properties).toHaveProperty('$schema');
			expect(mainSchema.properties).toHaveProperty('defaults');
			expect(mainSchema.properties).toHaveProperty('commands');
		});

		it('should include all command schemas', () => {
			const jsonSchema = createConfigSchemaJson();
			const commandsSchema = jsonSchema.definitions['ccusage-config'].properties.commands;

			expect(commandsSchema.properties).toHaveProperty('daily');
			expect(commandsSchema.properties).toHaveProperty('monthly');
			expect(commandsSchema.properties).toHaveProperty('weekly');
			expect(commandsSchema.properties).toHaveProperty('session');
			expect(commandsSchema.properties).toHaveProperty('blocks');
			expect(commandsSchema.properties).toHaveProperty('mcp');
			expect(commandsSchema.properties).toHaveProperty('statusline');
		});
	});
}
