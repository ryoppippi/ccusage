import type { Args } from 'gunshi';
import { z } from 'zod';

/**
 * Converts Gunshi args definition to Zod schema
 * @param args - Gunshi args definition
 * @returns Zod object schema with optional properties
 */
export function argsToZodSchema(args: Args): z.ZodObject<any> {
	const shape: Record<string, z.ZodType> = {};

	for (const [key, arg] of Object.entries(args)) {
		let schema: z.ZodType;

		// Convert based on arg type
		switch (arg.type) {
			case 'boolean':
				schema = z.boolean();
				break;
			case 'string':
				schema = z.string();
				break;
			case 'number':
				schema = z.number();
				break;
			case 'enum':
				if (arg.choices != null && arg.choices.length > 0) {
					schema = z.enum(arg.choices as [string, ...string[]]);
				}
				else {
					schema = z.string();
				}
				break;
			case 'custom':
				// Custom types are treated as strings - validation happens at runtime
				schema = z.string();
				break;
			case 'positional':
				// Positional args are treated as strings
				schema = z.string();
				break;
			default:
				// Fallback to string for unknown types
				schema = z.string();
				break;
		}

		// Add description if available
		if (arg.description != null) {
			schema = schema.describe(arg.description);
		}

		// Make all properties optional since they can be overridden by CLI args
		schema = schema.optional();

		// Add default value if specified
		if (arg.default !== undefined) {
			schema = schema.default(arg.default);
		}

		shape[key] = schema;
	}

	return z.object(shape);
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('argsToZodSchema', () => {
		it('should convert boolean args', () => {
			const args: Args = {
				debug: {
					type: 'boolean',
					description: 'Enable debug mode',
					default: false,
				},
			};

			const schema = argsToZodSchema(args);
			const result = schema.parse({ debug: true });
			expect(result.debug).toBe(true);

			// Test default value
			const resultDefault = schema.parse({});
			expect(resultDefault.debug).toBe(false);
		});

		it('should convert string args', () => {
			const args: Args = {
				name: {
					type: 'string',
					description: 'Name parameter',
				},
			};

			const schema = argsToZodSchema(args);
			const result = schema.parse({ name: 'test' });
			expect(result.name).toBe('test');

			// Test optional
			const resultOptional = schema.parse({});
			expect(resultOptional.name).toBeUndefined();
		});

		it('should convert number args', () => {
			const args: Args = {
				count: {
					type: 'number',
					description: 'Count parameter',
					default: 5,
				},
			};

			const schema = argsToZodSchema(args);
			const result = schema.parse({ count: 10 });
			expect(result.count).toBe(10);

			// Test default value
			const resultDefault = schema.parse({});
			expect(resultDefault.count).toBe(5);
		});

		it('should convert enum args', () => {
			const args: Args = {
				mode: {
					type: 'enum',
					description: 'Mode selection',
					choices: ['auto', 'manual'],
					default: 'auto',
				},
			};

			const schema = argsToZodSchema(args);
			const result = schema.parse({ mode: 'manual' });
			expect(result.mode).toBe('manual');

			// Test default value
			const resultDefault = schema.parse({});
			expect(resultDefault.mode).toBe('auto');

			// Test invalid enum value should throw
			expect(() => schema.parse({ mode: 'invalid' })).toThrow();
		});

		it('should convert custom args as strings', () => {
			const args: Args = {
				since: {
					type: 'custom',
					description: 'Date filter',
					parse: (value: string) => value, // Mock parse function
				},
			};

			const schema = argsToZodSchema(args);
			const result = schema.parse({ since: '20240101' });
			expect(result.since).toBe('20240101');
		});

		it('should handle mixed args types', () => {
			const args: Args = {
				debug: {
					type: 'boolean',
					default: false,
				},
				mode: {
					type: 'enum',
					choices: ['auto', 'manual'],
					default: 'auto',
				},
				count: {
					type: 'number',
					default: 1,
				},
				name: {
					type: 'string',
				},
			};

			const schema = argsToZodSchema(args);
			const result = schema.parse({
				debug: true,
				mode: 'manual',
				count: 5,
				name: 'test',
			});

			expect(result).toEqual({
				debug: true,
				mode: 'manual',
				count: 5,
				name: 'test',
			});

			// Test with defaults
			const resultDefaults = schema.parse({});
			expect(resultDefaults).toEqual({
				debug: false,
				mode: 'auto',
				count: 1,
			});
		});
	});
}
