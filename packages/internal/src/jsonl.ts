import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_BUFFERED_JSONL_BYTES = 128 * 1024 * 1024;

type BunFileLike = {
	size: number;
	text: () => Promise<string>;
	bytes: () => Promise<Uint8Array>;
};

type BunRuntimeLike = {
	file: (path: string) => BunFileLike;
};

function getBunRuntime(): BunRuntimeLike | null {
	const runtime = (globalThis as { Bun?: Partial<BunRuntimeLike> }).Bun;
	return typeof runtime?.file === 'function' ? (runtime as BunRuntimeLike) : null;
}

function hasNonWhitespace(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
			return true;
		}
	}
	return false;
}

async function processBufferedJSONLContent(
	content: string,
	processLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
	let lineStart = 0;
	let lineNumber = 0;
	while (lineStart < content.length) {
		let lineEnd = content.indexOf('\n', lineStart);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		lineNumber++;
		let line = content.slice(lineStart, lineEnd);
		if (line.endsWith('\r')) {
			line = line.slice(0, -1);
		}
		if (hasNonWhitespace(line)) {
			const result = processLine(line, lineNumber);
			if (result != null) {
				await result;
			}
		}

		lineStart = lineEnd + 1;
	}
}

export async function readBufferedJSONLContent(filePath: string): Promise<string | null> {
	const bun = getBunRuntime();
	if (bun != null) {
		const file = bun.file(filePath);
		if (file.size <= MAX_BUFFERED_JSONL_BYTES) {
			return file.text();
		}
		return null;
	}

	const file = await open(filePath, 'r');
	try {
		const stats = await file.stat();
		if (stats.size <= MAX_BUFFERED_JSONL_BYTES) {
			return (await file.readFile()).toString('utf8');
		}
		return null;
	} finally {
		await file.close();
	}
}

export async function processJSONLFileByLine(
	filePath: string,
	processLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
	const content = await readBufferedJSONLContent(filePath);
	if (content != null) {
		await processBufferedJSONLContent(content, processLine);
		return;
	}

	const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	let lineNumber = 0;
	for await (const line of rl) {
		lineNumber++;
		if (!hasNonWhitespace(line)) {
			continue;
		}
		const result = processLine(line, lineNumber);
		if (result != null) {
			await result;
		}
	}
}

if (import.meta.vitest != null) {
	describe('processJSONLFileByLine', () => {
		it('skips empty lines and preserves order', async () => {
			const directory = mkdtempSync(join(tmpdir(), 'ccusage-jsonl-'));
			const filePath = join(directory, 'test.jsonl');

			try {
				writeFileSync(filePath, '{"a":1}\n\n  \n{"a":2}\n');
				const lines: string[] = [];
				await processJSONLFileByLine(filePath, (line) => {
					lines.push(line);
				});

				expect(lines).toEqual(['{"a":1}', '{"a":2}']);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	});
}
