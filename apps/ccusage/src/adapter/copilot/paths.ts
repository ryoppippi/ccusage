import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { collectFilesRecursive, hasFileRecursive, isDirectorySyncSafe } from '@ccusage/internal/fs';
import { createFixture } from 'fs-fixture';
import { USER_HOME_DIR } from '../../consts.ts';

export const COPILOT_OTEL_FILE_EXPORTER_PATH_ENV = 'COPILOT_OTEL_FILE_EXPORTER_PATH';
const DEFAULT_COPILOT_OTEL_PATH = path.join(USER_HOME_DIR, '.copilot', 'otel');

function isFileSyncSafe(pathname: string): boolean {
	try {
		return statSync(pathname).isFile();
	} catch {
		return false;
	}
}

export function getCopilotOtelPath(): string | null {
	return isDirectorySyncSafe(DEFAULT_COPILOT_OTEL_PATH) ? DEFAULT_COPILOT_OTEL_PATH : null;
}

export function getCopilotExporterPath(): string | null {
	const value = process.env[COPILOT_OTEL_FILE_EXPORTER_PATH_ENV];
	if (value == null || value.trim() === '') {
		return null;
	}
	const resolved = path.resolve(value.trim());
	return existsSync(resolved) && isFileSyncSafe(resolved) ? resolved : null;
}

export async function discoverCopilotOtelFiles(): Promise<string[]> {
	const files = new Set<string>();
	const defaultPath = getCopilotOtelPath();
	if (defaultPath != null) {
		for (const file of await collectFilesRecursive(defaultPath, { extension: '.jsonl' })) {
			files.add(file);
		}
	}
	const exporterPath = getCopilotExporterPath();
	if (exporterPath != null) {
		files.add(exporterPath);
	}
	return Array.from(files).sort();
}

export async function detectCopilotOtelFiles(): Promise<boolean> {
	const exporterPath = getCopilotExporterPath();
	if (exporterPath != null) {
		return true;
	}
	const defaultPath = getCopilotOtelPath();
	return defaultPath == null ? false : hasFileRecursive(defaultPath, { extension: '.jsonl' });
}

if (import.meta.vitest != null) {
	describe('Copilot path discovery', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('includes the explicit OTEL exporter file', async () => {
			await using fixture = await createFixture({
				otel: {
					'copilot-explicit.jsonl': '{}',
				},
			});
			vi.stubEnv(
				COPILOT_OTEL_FILE_EXPORTER_PATH_ENV,
				fixture.getPath('otel/copilot-explicit.jsonl'),
			);

			await expect(discoverCopilotOtelFiles()).resolves.toEqual([
				fixture.getPath('otel/copilot-explicit.jsonl'),
			]);
		});

		it('ignores a missing explicit OTEL exporter file', async () => {
			await using fixture = await createFixture({
				otel: {},
			});
			vi.stubEnv(COPILOT_OTEL_FILE_EXPORTER_PATH_ENV, fixture.getPath('otel/missing.jsonl'));

			await expect(discoverCopilotOtelFiles()).resolves.toEqual([]);
		});
	});
}
