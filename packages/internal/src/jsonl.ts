import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createFixture } from 'fs-fixture';
import { readBufferedTextFile } from './fs.ts';

const MAX_BUFFERED_JSONL_BYTES = 128 * 1024 * 1024;

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

/**
 * Reads JSONL content into memory when the file fits within the shared buffer limit.
 *
 * @param filePath - JSONL file path to read.
 * @returns File contents, or null when the file should be streamed instead.
 */
export async function readBufferedJSONLContent(filePath: string): Promise<string | null> {
	return readBufferedTextFile(filePath, { maxBufferedBytes: MAX_BUFFERED_JSONL_BYTES });
}

/**
 * Processes a JSONL file line by line, skipping empty and whitespace-only lines.
 *
 * @param filePath - JSONL file path to process.
 * @param processLine - Callback invoked with each non-empty line and its 1-based line number.
 */
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
			await using fixture = await createFixture({
				'test.jsonl': '{"a":1}\n\n  \n{"a":2}\n',
			});
			const lines: string[] = [];
			await processJSONLFileByLine(fixture.getPath('test.jsonl'), (line) => {
				lines.push(line);
			});

			expect(lines).toEqual(['{"a":1}', '{"a":2}']);
		});
	});
}
