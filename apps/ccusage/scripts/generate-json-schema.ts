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
import { fileURLToPath } from 'node:url';
import { Result } from '@praha/byethrow';
import { $ } from 'bun';
import { allArgs } from '../src/commands/all.ts';
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

const AGENT_NAMES = ['claude', 'codex', 'opencode', 'amp', 'pi'] as const;
type AgentName = (typeof AGENT_NAMES)[number];
type JsonSchemaNode = {
	[key: string]: unknown;
	type?: string;
	properties?: Record<string, JsonSchemaNode>;
	definitions?: Record<string, JsonSchemaNode>;
};
type TokenDefinition = {
	[key: string]: unknown;
	type: string;
	choices?: readonly unknown[];
	description?: string;
	default?: unknown;
};
type TokenSchema = Record<string, TokenDefinition>;

/**
 * Convert args-tokens schema to JSON Schema format
 */
function tokensSchemaToJsonSchema(schema: TokenSchema): JsonSchemaNode {
	const properties: Record<string, JsonSchemaNode> = {};

	for (const [key, argTyped] of Object.entries(schema)) {
		const property: JsonSchemaNode = {};

		// Handle type conversion
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
				if (argTyped.choices != null && Array.isArray(argTyped.choices)) {
					property.enum = argTyped.choices;
				}
				break;
			default:
				property.type = 'string';
		}

		// Add description
		if (argTyped.description != null) {
			property.description = argTyped.description;
			property.markdownDescription = argTyped.description;
		}

		// Add default value
		if ('default' in argTyped && argTyped.default !== undefined) {
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

function splitCommandName(name: string): { agent?: AgentName; report: string } {
	const [prefix, report] = name.split(':');
	if (report != null && AGENT_NAMES.includes(prefix as AgentName)) {
		return { agent: prefix as AgentName, report };
	}
	return { report: name };
}

function filterCommandSchema(report: string, schema: TokenSchema): TokenSchema {
	const commandExcludes = COMMAND_EXCLUDE_KEYS[report] ?? [];
	return Object.fromEntries(
		Object.entries(schema).filter(
			([key]) => !EXCLUDE_KEYS.includes(key) && !commandExcludes.includes(key),
		),
	);
}

function commonSchemaProperties(commandSchemas: Record<string, TokenSchema>): TokenSchema {
	const schemas = Object.values(commandSchemas);
	const firstSchema = schemas[0];
	if (firstSchema == null) {
		return {};
	}
	const restSchemas = schemas.slice(1);
	return Object.fromEntries(
		Object.entries(firstSchema).filter(([key]) =>
			restSchemas.every((schema) => Object.hasOwn(schema, key)),
		),
	);
}

function createCommandsJsonSchema(
	commandSchemas: Record<string, TokenSchema>,
	description: string,
): JsonSchemaNode {
	return {
		type: 'object',
		properties: Object.fromEntries(
			Object.entries(commandSchemas).map(([name, schema]) => [
				name,
				tokensSchemaToJsonSchema(schema),
			]),
		),
		additionalProperties: false,
		description,
		markdownDescription: description,
	};
}

function createAgentJsonSchema(
	agentName: AgentName,
	commandSchemas: Record<string, TokenSchema>,
): JsonSchemaNode {
	const agentLabel = agentName === 'pi' ? 'pi-agent' : agentName;
	return {
		type: 'object',
		properties: {
			defaults: {
				...tokensSchemaToJsonSchema(commonSchemaProperties(commandSchemas)),
				description: `Default values for ${agentLabel} commands`,
				markdownDescription: `Default values for ${agentLabel} commands`,
			},
			commands: createCommandsJsonSchema(
				commandSchemas,
				`Command-specific configuration overrides for ${agentLabel}`,
			),
		},
		additionalProperties: false,
		description: `${agentLabel} command configuration`,
		markdownDescription: `${agentLabel} command configuration`,
	};
}

/**
 * Create the complete configuration schema from all command definitions
 */
function createConfigSchemaJson(): JsonSchemaNode {
	const topLevelCommandSchemas: Record<string, TokenSchema> = {};
	const agentCommandSchemas = Object.fromEntries(AGENT_NAMES.map((agent) => [agent, {}])) as Record<
		AgentName,
		Record<string, TokenSchema>
	>;

	for (const [commandName, command] of subCommandUnion) {
		const { agent, report } = splitCommandName(commandName);
		const commandSchema = filterCommandSchema(report, command.args as TokenSchema);
		if (agent == null) {
			topLevelCommandSchemas[report] = commandSchema;
		} else {
			agentCommandSchemas[agent][report] = commandSchema;
		}
	}

	const legacyTopLevelCommandSchemas = Object.fromEntries(
		Object.entries(topLevelCommandSchemas).map(([report, schema]) => [
			report,
			{
				...(agentCommandSchemas.claude[report] ?? {}),
				...schema,
			},
		]),
	);
	const defaultsJsonSchema = tokensSchemaToJsonSchema({
		...commonSchemaProperties(agentCommandSchemas.claude),
		...filterCommandSchema('daily', allArgs as TokenSchema),
	});
	const commandsJsonSchema = createCommandsJsonSchema(
		legacyTopLevelCommandSchemas,
		'Command-specific configuration overrides for all-agent reports',
	);

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
						...defaultsJsonSchema,
						description: 'Default values for all-agent reports and legacy Claude commands',
						markdownDescription: 'Default values for all-agent reports and legacy Claude commands',
					},
					commands: commandsJsonSchema,
					claude: createAgentJsonSchema('claude', agentCommandSchemas.claude),
					codex: createAgentJsonSchema('codex', agentCommandSchemas.codex),
					opencode: createAgentJsonSchema('opencode', agentCommandSchemas.opencode),
					amp: createAgentJsonSchema('amp', agentCommandSchemas.amp),
					pi: createAgentJsonSchema('pi', agentCommandSchemas.pi),
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
					timezone: 'Asia/Tokyo',
				},
				claude: {
					defaults: {
						mode: 'auto',
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
				codex: {
					defaults: {
						speed: 'auto',
					},
				},
			},
		],
	};
}

/**
 * Generate JSON Schema and write to files
 */
async function runFormat(files: string[]) {
	return Result.try({
		try: $`pnpm exec oxfmt ${files}`,
		catch: (error) => error,
	});
}

async function writeFile(path: string, content: string) {
	const attempt = Result.try({
		try: async () => Bun.write(path, content),
		catch: (error) => error,
	});
	return attempt();
}

async function readFile(path: string): Promise<Result.Result<string, any>> {
	return Result.try({
		try: async () => {
			const file = Bun.file(path);
			return file.text();
		},
		catch: (error) => error,
	})();
}

async function copySchemaToDocsPublic() {
	const docsSchemaPath = fileURLToPath(
		new URL(`../../../docs/public/${SCHEMA_FILENAME}`, import.meta.url),
	);
	await writeFile(docsSchemaPath, await Bun.file(SCHEMA_FILENAME).text());
}

async function generateJsonSchema() {
	logger.info('Generating JSON Schema from args-tokens configuration schema...');

	// Create the JSON Schema
	const schemaObject = Result.pipe(
		Result.try({
			try: () => createConfigSchemaJson(),
			catch: (error) => error,
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
		Result.map((content) =>
			Result.pipe(
				Result.try({
					try: () => JSON.parse(content) as unknown,
					catch: () => '',
				})(),
				Result.unwrap(''),
			),
		),
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

	// Run format on the root schema file that was changed
	await Result.pipe(
		Result.try({
			try: runFormat([SCHEMA_FILENAME]),
			safe: true,
		}),
		Result.inspectError((error) => {
			logger.error('Failed to format generated files:', error);
			process.exit(1);
		}),
		Result.inspect(() => logger.info('✓ Formatted generated files')),
	);

	logger.info('JSON Schema generation completed successfully!');
}

// Run the generator
if (import.meta.main) {
	await generateJsonSchema();
}
if (import.meta.vitest != null) {
	function schemaProperties(schema: JsonSchemaNode): Record<string, JsonSchemaNode> {
		return schema.properties ?? {};
	}

	function configSchemaDefinition(schema: JsonSchemaNode): JsonSchemaNode {
		return schema.definitions?.['ccusage-config'] ?? {};
	}

	describe('tokensSchemaToJsonSchema', () => {
		it('should convert boolean args to JSON Schema', () => {
			const schema = {
				debug: {
					type: 'boolean',
					description: 'Enable debug mode',
					default: false,
				},
			} satisfies TokenSchema;

			const jsonSchema = tokensSchemaToJsonSchema(schema);
			expect(schemaProperties(jsonSchema).debug).toEqual({
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
			} satisfies TokenSchema;

			const jsonSchema = tokensSchemaToJsonSchema(schema);
			expect(schemaProperties(jsonSchema).mode).toEqual({
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
			expect(configSchemaDefinition(jsonSchema)).toBeDefined();
			expect(configSchemaDefinition(jsonSchema).type).toBe('object');
		});

		it('should include all expected properties', () => {
			const jsonSchema = createConfigSchemaJson();
			const mainSchema = configSchemaDefinition(jsonSchema);
			const properties = schemaProperties(mainSchema);

			expect(properties).toHaveProperty('$schema');
			expect(properties).toHaveProperty('defaults');
			expect(properties).toHaveProperty('commands');
			expect(properties).toHaveProperty('claude');
			expect(properties).toHaveProperty('codex');
		});

		it('should keep legacy top-level Claude config properties', () => {
			const jsonSchema = createConfigSchemaJson();
			const mainSchema = configSchemaDefinition(jsonSchema);
			const properties = schemaProperties(mainSchema);
			const defaultsSchema = properties.defaults ?? {};
			const commandsSchema = properties.commands ?? {};
			const dailySchema = schemaProperties(commandsSchema).daily ?? {};

			expect(schemaProperties(defaultsSchema)).toHaveProperty('mode');
			expect(schemaProperties(dailySchema)).toHaveProperty('instances');
		});

		it('should include all command schemas', () => {
			const jsonSchema = createConfigSchemaJson();
			const mainSchema = configSchemaDefinition(jsonSchema);
			const commandsSchema = schemaProperties(mainSchema).commands ?? {};
			const commandProperties = schemaProperties(commandsSchema);

			expect(commandProperties).toHaveProperty('daily');
			expect(commandProperties).toHaveProperty('monthly');
			expect(commandProperties).toHaveProperty('weekly');
			expect(commandProperties).toHaveProperty('session');
			expect(commandProperties).not.toHaveProperty('codex:daily');
		});

		it('should include agent command schemas under agent namespaces', () => {
			const jsonSchema = createConfigSchemaJson();
			const mainSchema = configSchemaDefinition(jsonSchema);
			const properties = schemaProperties(mainSchema);
			const claudeCommands = schemaProperties(properties.claude ?? {}).commands ?? {};
			const codexCommands = schemaProperties(properties.codex ?? {}).commands ?? {};
			const claudeCommandProperties = schemaProperties(claudeCommands);
			const codexCommandProperties = schemaProperties(codexCommands);

			expect(claudeCommandProperties).toHaveProperty('daily');
			expect(claudeCommandProperties).toHaveProperty('blocks');
			expect(claudeCommandProperties).toHaveProperty('statusline');
			expect(codexCommandProperties).toHaveProperty('daily');
			expect(codexCommandProperties).toHaveProperty('monthly');
			expect(codexCommandProperties).toHaveProperty('session');
		});
	});
}
