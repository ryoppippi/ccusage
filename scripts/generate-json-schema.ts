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
	// Exclude config option from schema since it's CLI-only
	const excludeKeys = ['config'];

	// Create schema for default/shared arguments (excluding CLI-only options)
	const defaultsSchema = Object.fromEntries(
		Object.entries(sharedArgs).filter(([key]) => !excludeKeys.includes(key)),
	);

	// Create schemas for each command's specific arguments (excluding CLI-only options)
	const commandSchemas: Record<string, any> = {};
	for (const [commandName, command] of subCommandUnion) {
		commandSchemas[commandName] = Object.fromEntries(
			Object.entries(command.args as Record<string, any>).filter(([key]) => !excludeKeys.includes(key)),
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
	return Result.try({
		try: Bun.write(path, content),
		catch: error => error,
	});
}

async function generateJsonSchema() {
	logger.info('Generating JSON Schema from args-tokens configuration schema...');

	// Create the JSON Schema
	const schemaResult = Result.try({
		try: () => createConfigSchemaJson(),
		catch: error => error,
	})();
	if (Result.isFailure(schemaResult)) {
		logger.error('Failed to create JSON Schema:', schemaResult.error);
		process.exit(1);
	}

	// Write schema files
	const schemaJson = JSON.stringify(schemaResult.value, null, '\t');

	const configSchemaResult = await writeFile('config-schema.json', schemaJson);
	if (Result.isFailure(configSchemaResult)) {
		logger.error('Failed to write config-schema.json:', configSchemaResult.error);
		process.exit(1);
	}
	logger.info('✓ Generated config-schema.json');

	const docsSchemaResult = await writeFile('docs/public/config-schema.json', schemaJson);
	if (Result.isFailure(docsSchemaResult)) {
		logger.error('Failed to write docs/public/config-schema.json:', docsSchemaResult.error);
		process.exit(1);
	}
	logger.info('✓ Generated docs/public/config-schema.json');

	// Run lint on generated files
	const lintResult = await runLint(['config-schema.json', 'docs/public/config-schema.json']);
	if (Result.isFailure(lintResult)) {
		logger.error('Failed to lint generated files:', lintResult.error);
		process.exit(1);
	}
	logger.info('✓ Linted generated files');

	logger.info('JSON Schema generation completed successfully!');
}

// Run the generator
if (import.meta.main) {
	await generateJsonSchema();
}

export { createConfigSchemaJson, generateJsonSchema, tokensSchemaToJsonSchema };

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
