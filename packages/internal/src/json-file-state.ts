import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type JsonFileState<T> = {
	data: T | undefined;
	[Symbol.dispose]: () => void;
};

export function createJsonFileState<T>(filePath: string): JsonFileState<T> {
	mkdirSync(dirname(filePath), { recursive: true });

	let data: T | undefined;
	if (existsSync(filePath)) {
		const text = readFileSync(filePath, 'utf8');
		if (text.trim() !== '') {
			data = JSON.parse(text) as T;
		}
	}

	return {
		data,
		[Symbol.dispose]() {
			if (this.data != null) {
				writeFileSync(filePath, JSON.stringify(this.data, null, 2));
			}
		},
	};
}

if (import.meta.vitest != null) {
	describe('createJsonFileState', () => {
		it('stores data into a missing JSON file on dispose', () => {
			const directory = mkdtempSync(join(tmpdir(), 'ccusage-json-file-state-'));
			const filePath = join(directory, 'nested', 'cache.json');

			try {
				{
					using state = createJsonFileState<{ value: string }>(filePath);
					expect(state.data).toBeUndefined();
					state.data = { value: 'fresh' };
				}

				expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 'fresh' });
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});

		it('loads existing JSON data and writes updated data on dispose', () => {
			const directory = mkdtempSync(join(tmpdir(), 'ccusage-json-file-state-'));
			const filePath = join(directory, 'cache.json');
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, JSON.stringify({ count: 1 }));

			try {
				{
					using state = createJsonFileState<{ count: number }>(filePath);
					expect(state.data).toEqual({ count: 1 });
					state.data = { count: 2 };
				}

				expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ count: 2 });
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	});
}
