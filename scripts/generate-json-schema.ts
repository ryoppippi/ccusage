#!/usr/bin/env bun

/**
 * @fileoverview Generate JSON Schema from Zod configuration schema
 *
 * This script generates a JSON Schema file from the Zod configuration schema
 * for ccusage configuration files. The generated schema enables:
 * - IDE autocomplete and validation
 * - Documentation of available options
 * - Schema validation for configuration files
 */

import { existsSync, mkdirSync } from 'node:fs';
import process from 'node:process';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createConfigSchema } from '../src/_config-schema.ts';
import { logger } from '../src/logger.ts';

/**
 * Generate JSON Schema and write to files
 */
async function generateJsonSchema() {
	logger.info('Generating JSON Schema from Zod configuration schema...');

	try {
		// Create the Zod schema
		const configSchema = createConfigSchema();

		// Convert to JSON Schema
		const jsonSchema = zodToJsonSchema(configSchema, {
			name: 'ccusage-config',
			$refStrategy: 'none', // Inline all definitions for better IDE support
			markdownDescription: true, // Enable markdown in descriptions
			target: 'jsonSchema7', // Use JSON Schema Draft 7
			definitionPath: '#/definitions/',
			// Add additional metadata
			additionalProperties: false,
		});

		// Add custom properties to the schema
		const enhancedSchema = {
			...jsonSchema,
			title: 'ccusage Configuration',
			description: 'Configuration file for ccusage - Claude Code usage analysis tool',
			examples: [
				{
					$schema: './ccusage.schema.json',
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

		// Ensure directories exist
		const schemaDir = 'schema';
		const docsSchemaDir = 'docs/public/schema';

		if (!existsSync(schemaDir)) {
			mkdirSync(schemaDir, { recursive: true });
		}
		if (!existsSync(docsSchemaDir)) {
			mkdirSync(docsSchemaDir, { recursive: true });
		}

		// Write schema files
		const schemaJson = JSON.stringify(enhancedSchema, null, 2);

		await Bun.write(`${schemaDir}/ccusage.schema.json`, schemaJson);
		logger.info(`✓ Generated schema/ccusage.schema.json`);

		await Bun.write(`${docsSchemaDir}/ccusage.schema.json`, schemaJson);
		logger.info(`✓ Generated docs/public/schema/ccusage.schema.json`);

		logger.info('JSON Schema generation completed successfully!');
	}
	catch (error) {
		logger.error('Failed to generate JSON Schema:', error);
		process.exit(1);
	}
}

// Run the generator
if (import.meta.main) {
	await generateJsonSchema();
}

export { generateJsonSchema };

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('generateJsonSchema', () => {
		it('should generate valid JSON Schema', async () => {
			// Test the schema generation process
			const configSchema = createConfigSchema();
			const jsonSchema = zodToJsonSchema(configSchema, {
				name: 'ccusage-config',
				$refStrategy: 'none',
			});

			expect(jsonSchema).toBeDefined();
			expect(jsonSchema.type).toBe('object');
			expect(jsonSchema.properties).toBeDefined();

			// Check for key properties
			expect(jsonSchema.properties).toHaveProperty('$schema');
			expect(jsonSchema.properties).toHaveProperty('defaults');
			expect(jsonSchema.properties).toHaveProperty('commands');
		});

		it('should include command-specific properties', async () => {
			const configSchema = createConfigSchema();
			const jsonSchema = zodToJsonSchema(configSchema);

			const commandsSchema = (jsonSchema.properties as Record<string, any>)?.commands as { properties?: Record<string, unknown> } | undefined;
			expect(commandsSchema).toBeDefined();
			if (commandsSchema?.properties != null) {
				expect(commandsSchema.properties).toHaveProperty('daily');
				expect(commandsSchema.properties).toHaveProperty('blocks');
				expect(commandsSchema.properties).toHaveProperty('session');
			}
		});
	});
}
