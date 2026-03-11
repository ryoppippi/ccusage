/**
 * @fileoverview Factory settings loader.
 *
 * Factory stores global configuration under `~/.factory/settings.json`, including
 * `customModels[]` mappings used to resolve `custom:*` model IDs.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import * as v from 'valibot';
import { DEFAULT_FACTORY_DIR, FACTORY_DIR_ENV } from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Normalizes unknown errors into `Error` instances.
 */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Type guard for Node.js `ErrnoException` errors.
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

const customModelSchema = v.object({
	id: v.string(),
	model: v.string(),
	provider: v.optional(v.string()),
	displayName: v.optional(v.string()),
});

const settingsSchema = v.object({
	customModels: v.optional(v.array(customModelSchema)),
});

export type FactoryCustomModel = v.InferOutput<typeof customModelSchema>;

/**
 * Resolves the Factory data directory.
 *
 * Precedence: CLI `--factoryDir` → `FACTORY_DIR` → `~/.factory`.
 */
export function resolveFactoryDir(cliFactoryDir?: string): string {
	return cliFactoryDir ?? process.env[FACTORY_DIR_ENV] ?? DEFAULT_FACTORY_DIR;
}

/**
 * Loads Factory custom model mappings from `settings.json`.
 *
 * Returns an empty map if the file is missing or invalid.
 */
export async function loadFactoryCustomModels(
	factoryDir: string,
): Promise<Map<string, FactoryCustomModel>> {
	const settingsPath = path.join(factoryDir, 'settings.json');
	const raw = await Result.try({
		try: readFile(settingsPath, 'utf8'),
		catch: (error) => toError(error),
	});

	if (Result.isFailure(raw)) {
		const error = raw.error;
		if (isErrnoException(error) && error.code === 'ENOENT') {
			return new Map();
		}
		logger.warn(`Failed to read Factory settings at ${settingsPath}:`, error);
		return new Map();
	}

	const parsedJson = Result.try({
		try: () => JSON.parse(raw.value) as unknown,
		catch: (error) => toError(error),
	})();
	if (Result.isFailure(parsedJson)) {
		logger.warn(`Failed to parse Factory settings at ${settingsPath}:`, parsedJson.error);
		return new Map();
	}

	const parsed = v.safeParse(settingsSchema, parsedJson.value);
	if (!parsed.success) {
		logger.warn(`Invalid Factory settings schema at ${settingsPath}`);
		return new Map();
	}

	const map = new Map<string, FactoryCustomModel>();
	for (const model of parsed.output.customModels ?? []) {
		map.set(model.id, model);
	}
	return map;
}

if (import.meta.vitest != null) {
	describe('loadFactoryCustomModels', () => {
		it('loads custom model ids from settings.json', async () => {
			const fixture = await createFixture({
				'settings.json': JSON.stringify(
					{
						customModels: [{ id: 'custom:Test-0', model: 'gpt-5.2', provider: 'openai' }],
					},
					null,
					2,
				),
			});

			const models = await loadFactoryCustomModels(fixture.path);
			expect(models.get('custom:Test-0')?.model).toBe('gpt-5.2');
		});
	});
}
