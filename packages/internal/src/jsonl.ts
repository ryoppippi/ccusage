import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createFixture } from 'fs-fixture';
import { readBufferedBytesFile, readBufferedTextFile } from './fs.ts';

const MAX_BUFFERED_JSONL_BYTES = 128 * 1024 * 1024;

/**
 * Controls marker-based JSONL scanning.
 *
 * `scanMode: "marker"` scans encoded bytes for marker strings and decodes only
 * matching lines. `scanMode: "line"` decodes the buffered file first and checks
 * each non-empty line. `bufferedEncoding` is the encoding used for buffered
 * decode paths. `markerIndex: "byte"` reports marker offsets in encoded bytes;
 * `markerIndex: "decoded"` reports JavaScript string indexes. `callbackMode:
 * "sync"` is valid when callbacks do not return promises.
 */
type JSONLMarkerProcessingOptions = {
	bufferedEncoding?: BufferEncoding;
	callbackMode?: 'async' | 'sync';
	markerIndex?: 'byte' | 'decoded';
	scanMode?: 'marker' | 'line';
};

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

function normalizeMarker(value: string): string | null {
	return hasNonWhitespace(value) ? value : null;
}

function markerIndexForLine(
	line: string,
	markerIndex: number,
	options: JSONLMarkerProcessingOptions,
): number {
	return options.markerIndex === 'byte'
		? Buffer.byteLength(line.slice(0, markerIndex), options.bufferedEncoding ?? 'utf8')
		: markerIndex;
}

async function processBufferedJSONLMarkerBytes(
	bytes: Uint8Array,
	markers: readonly string[],
	processLine: (line: string, markerIndex: number, marker: string) => void | Promise<void>,
	options: JSONLMarkerProcessingOptions = {},
): Promise<void> {
	const content = Buffer.isBuffer(bytes)
		? bytes
		: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (options.scanMode === 'line') {
		await processBufferedJSONLMarkerContent(
			content.toString(options.bufferedEncoding ?? 'utf8'),
			markers,
			processLine,
			options,
		);
		return;
	}

	const markerBuffers = markers.map((marker) => Buffer.from(marker));
	if (markerBuffers.length === 1) {
		await processBufferedJSONLSingleMarkerBytes(
			content,
			markerBuffers[0]!,
			markers[0]!,
			processLine,
			options,
		);
		return;
	}

	const candidates = new Map<number, { lineEnd: number; markerIndex: number; marker: string }>();

	for (let markerBufferIndex = 0; markerBufferIndex < markerBuffers.length; markerBufferIndex++) {
		const markerBuffer = markerBuffers[markerBufferIndex]!;
		const marker = markers[markerBufferIndex]!;
		let markerIndex = content.indexOf(markerBuffer, 0);
		while (markerIndex !== -1) {
			const previousLineEnd = markerIndex === 0 ? -1 : content.lastIndexOf(10, markerIndex - 1);
			const lineStart = previousLineEnd + 1;
			let lineEnd = content.indexOf(10, markerIndex);
			if (lineEnd === -1) {
				lineEnd = content.length;
			}
			const lineMarkerIndex = markerIndex - lineStart;
			const existing = candidates.get(lineStart);
			if (existing == null || lineMarkerIndex < existing.markerIndex) {
				candidates.set(lineStart, { lineEnd, markerIndex: lineMarkerIndex, marker });
			}
			markerIndex = content.indexOf(markerBuffer, markerIndex + markerBuffer.length);
		}
	}

	const lineStarts = Array.from(candidates.keys()).sort((a, b) => a - b);
	if (options.callbackMode === 'sync') {
		for (const lineStart of lineStarts) {
			const candidate = candidates.get(lineStart)!;
			const lineEnd = candidate.lineEnd;
			const decodeEnd = lineEnd > lineStart && content[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
			const line = content.toString(options.bufferedEncoding ?? 'utf8', lineStart, decodeEnd);
			void processLine(
				line,
				options.markerIndex === 'byte' ? candidate.markerIndex : line.indexOf(candidate.marker),
				candidate.marker,
			);
		}
		return;
	}

	for (const lineStart of lineStarts) {
		const candidate = candidates.get(lineStart)!;
		const lineEnd = candidate.lineEnd;
		const decodeEnd = lineEnd > lineStart && content[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
		const line = content.toString(options.bufferedEncoding ?? 'utf8', lineStart, decodeEnd);
		const markerIndex =
			options.markerIndex === 'byte' ? candidate.markerIndex : line.indexOf(candidate.marker);
		const result = processLine(line, markerIndex, candidate.marker);
		if (result != null) {
			await result;
		}
	}
}

async function processBufferedJSONLSingleMarkerBytes(
	content: Buffer,
	markerBuffer: Buffer,
	marker: string,
	processLine: (line: string, markerIndex: number, marker: string) => void | Promise<void>,
	options: JSONLMarkerProcessingOptions,
): Promise<void> {
	let lineStart = 0;
	let markerIndex = content.indexOf(markerBuffer, lineStart);
	if (options.callbackMode === 'sync') {
		while (markerIndex !== -1) {
			while (true) {
				const nextLineEnd = content.indexOf(10, lineStart);
				if (nextLineEnd === -1 || nextLineEnd >= markerIndex) {
					break;
				}
				lineStart = nextLineEnd + 1;
			}
			let lineEnd = content.indexOf(10, markerIndex);
			if (lineEnd === -1) {
				lineEnd = content.length;
			}

			const decodeEnd = lineEnd > lineStart && content[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
			const line = content.toString(options.bufferedEncoding ?? 'utf8', lineStart, decodeEnd);
			const lineMarkerIndex = markerIndex - lineStart;
			void processLine(
				line,
				options.markerIndex === 'byte' ? lineMarkerIndex : line.indexOf(marker),
				marker,
			);

			lineStart = lineEnd + 1;
			markerIndex = content.indexOf(markerBuffer, lineStart);
		}
		return;
	}

	while (markerIndex !== -1) {
		while (true) {
			const nextLineEnd = content.indexOf(10, lineStart);
			if (nextLineEnd === -1 || nextLineEnd >= markerIndex) {
				break;
			}
			lineStart = nextLineEnd + 1;
		}
		let lineEnd = content.indexOf(10, markerIndex);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		const decodeEnd = lineEnd > lineStart && content[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
		const line = content.toString(options.bufferedEncoding ?? 'utf8', lineStart, decodeEnd);
		const lineMarkerIndex = markerIndex - lineStart;
		const result = processLine(
			line,
			options.markerIndex === 'byte' ? lineMarkerIndex : line.indexOf(marker),
			marker,
		);
		if (result != null) {
			await result;
		}

		lineStart = lineEnd + 1;
		markerIndex = content.indexOf(markerBuffer, lineStart);
	}
}

async function processBufferedJSONLMarkerContent(
	content: string,
	markers: readonly string[],
	processLine: (line: string, markerIndex: number, marker: string) => void | Promise<void>,
	options: JSONLMarkerProcessingOptions = {},
): Promise<void> {
	let lineStart = 0;
	while (lineStart < content.length) {
		let lineEnd = content.indexOf('\n', lineStart);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		let line = content.slice(lineStart, lineEnd);
		if (line.endsWith('\r')) {
			line = line.slice(0, -1);
		}
		if (hasNonWhitespace(line)) {
			let firstMarkerIndex = -1;
			let firstMarker: string | undefined;
			for (const marker of markers) {
				const markerIndex = line.indexOf(marker);
				if (markerIndex !== -1 && (firstMarkerIndex === -1 || markerIndex < firstMarkerIndex)) {
					firstMarkerIndex = markerIndex;
					firstMarker = marker;
				}
			}
			if (firstMarker != null) {
				const callbackMarkerIndex = markerIndexForLine(line, firstMarkerIndex, options);
				if (options.callbackMode === 'sync') {
					void processLine(line, callbackMarkerIndex, firstMarker);
					lineStart = lineEnd + 1;
					continue;
				}
				const result = processLine(line, callbackMarkerIndex, firstMarker);
				if (result != null) {
					await result;
				}
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
 * Reads JSONL bytes into memory when the file fits within the shared buffer limit.
 *
 * @param filePath - JSONL file path to read.
 * @returns File bytes, or null when the file should be streamed instead.
 */
export async function readBufferedJSONLBytes(filePath: string): Promise<Uint8Array | null> {
	return readBufferedBytesFile(filePath, { maxBufferedBytes: MAX_BUFFERED_JSONL_BYTES });
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

/**
 * Processes JSONL lines that contain one of the supplied marker strings.
 *
 * Buffered files can be scanned by encoded marker bytes or by decoded lines.
 * When `markerIndex` is `"byte"`, callbacks receive byte offsets for every
 * buffered and streamed path; otherwise they receive decoded string indexes.
 *
 * @param filePath - JSONL file path to process.
 * @param markers - Non-empty marker strings used to select relevant lines.
 * @param processLine - Callback invoked with the matching line, marker index, and marker.
 * @param options - Marker scanning options.
 */
export async function processJSONLFileByMarkers(
	filePath: string,
	markers: readonly string[],
	processLine: (line: string, markerIndex: number, marker: string) => void | Promise<void>,
	options: JSONLMarkerProcessingOptions = {},
): Promise<void> {
	const normalizedMarkers = markers.map(normalizeMarker).filter((marker) => marker != null);
	if (normalizedMarkers.length === 0) {
		return;
	}

	const bytes = await readBufferedJSONLBytes(filePath);
	if (bytes != null) {
		await processBufferedJSONLMarkerBytes(bytes, normalizedMarkers, processLine, options);
		return;
	}

	const content = await readBufferedJSONLContent(filePath);
	if (content != null) {
		await processBufferedJSONLMarkerContent(content, normalizedMarkers, processLine, options);
		return;
	}

	const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		let firstMarkerIndex = -1;
		let firstMarker: string | undefined;
		for (const marker of normalizedMarkers) {
			const markerIndex = line.indexOf(marker);
			if (markerIndex !== -1 && (firstMarkerIndex === -1 || markerIndex < firstMarkerIndex)) {
				firstMarkerIndex = markerIndex;
				firstMarker = marker;
			}
		}
		if (firstMarker == null) {
			continue;
		}
		const callbackMarkerIndex = markerIndexForLine(line, firstMarkerIndex, options);
		if (options.callbackMode === 'sync') {
			void processLine(line, callbackMarkerIndex, firstMarker);
			continue;
		}
		const result = processLine(line, callbackMarkerIndex, firstMarker);
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

	describe('processJSONLFileByMarkers', () => {
		it('decodes only lines containing one of the requested markers in file order', async () => {
			await using fixture = await createFixture({
				'test.jsonl': [
					'{"type":"noise","content":"token_count appears nowhere useful"}',
					'{"type":"turn_context","payload":{"model":"gpt-5.4"}}',
					'{"type":"event_msg","payload":{"type":"token_count"}}',
				].join('\n'),
			});

			const seen: Array<{ line: string; marker: string; markerIndex: number }> = [];
			await processJSONLFileByMarkers(
				fixture.getPath('test.jsonl'),
				['turn_context', '"type":"token_count"'],
				(line, markerIndex, marker) => {
					seen.push({ line, marker, markerIndex });
				},
			);

			expect(seen).toEqual([
				{
					line: '{"type":"turn_context","payload":{"model":"gpt-5.4"}}',
					marker: 'turn_context',
					markerIndex: 9,
				},
				{
					line: '{"type":"event_msg","payload":{"type":"token_count"}}',
					marker: '"type":"token_count"',
					markerIndex: 31,
				},
			]);
		});

		it('preserves UTF-8 content and reports marker indexes in decoded strings', async () => {
			const markedLine = '{"note":"東京","payload":{"type":"token_count","text":"👋"}}';
			const marker = '"type":"token_count"';
			await using fixture = await createFixture({
				'test.jsonl': markedLine,
			});

			const seen: Array<{ line: string; markerIndex: number }> = [];
			await processJSONLFileByMarkers(
				fixture.getPath('test.jsonl'),
				[marker],
				(line, markerIndex) => {
					seen.push({ line, markerIndex });
				},
			);

			expect(seen).toEqual([
				{
					line: markedLine,
					markerIndex: markedLine.indexOf(marker),
				},
			]);
		});

		it('can use single-byte buffered decoding for ASCII-only hot paths', async () => {
			const markedLine = '{"note":"東京","payload":{"type":"token_count","text":"👋"}}';
			const marker = '"type":"token_count"';
			await using fixture = await createFixture({
				'test.jsonl': markedLine,
			});

			const seen: Array<{ line: string; markerIndex: number }> = [];
			await processJSONLFileByMarkers(
				fixture.getPath('test.jsonl'),
				[marker],
				(line, markerIndex) => {
					seen.push({ line, markerIndex });
				},
				{ bufferedEncoding: 'latin1', markerIndex: 'byte' },
			);

			expect(seen).toEqual([
				{
					line: Buffer.from(markedLine).toString('latin1'),
					markerIndex: Buffer.byteLength(markedLine.slice(0, markedLine.indexOf(marker))),
				},
			]);
		});

		it('can scan buffered files by line for marker-dense logs', async () => {
			await using fixture = await createFixture({
				'test.jsonl': [
					'{"type":"turn_context","payload":{"model":"gpt-5.4"}}',
					'{"type":"event_msg","payload":{"type":"token_count"}}',
					'{"type":"noise","payload":{"text":"ignored"}}',
				].join('\n'),
			});

			const seen: string[] = [];
			await processJSONLFileByMarkers(
				fixture.getPath('test.jsonl'),
				['turn_context', '"type":"token_count"'],
				(line) => {
					seen.push(line);
				},
				{ scanMode: 'line' },
			);

			expect(seen).toEqual([
				'{"type":"turn_context","payload":{"model":"gpt-5.4"}}',
				'{"type":"event_msg","payload":{"type":"token_count"}}',
			]);
		});

		it('returns byte marker indexes in line-scan mode', async () => {
			const prefix = '{"note":"東京",';
			const marker = '"type":"token_count"';
			await using fixture = await createFixture({
				'test.jsonl': `${prefix}${marker}}`,
			});

			const seen: number[] = [];
			await processJSONLFileByMarkers(
				fixture.getPath('test.jsonl'),
				[marker],
				(_line, markerIndex) => {
					seen.push(markerIndex);
				},
				{ markerIndex: 'byte', scanMode: 'line' },
			);

			expect(seen).toEqual([Buffer.byteLength(prefix)]);
		});
	});
}
