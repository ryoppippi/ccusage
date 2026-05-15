#!/usr/bin/env bun

import { join, resolve } from 'node:path';
import { cli, define } from 'gunshi';

const DEFAULT_SIZE_MIB = 1024;
const CHUNK_LINE_COUNT = 4096;
const FLUSH_INTERVAL_BYTES = 64 * 1024 * 1024;

/**
 * Formats generated fixture size for CI logs.
 */
function formatBytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Creates one deterministic usage row that stays on ccusage's normal fast parser path.
 *
 * Every row has a unique message/request id so deduplication does not collapse the 1 GiB
 * fixture into a tiny workload. The timestamp/model/token values still cycle enough to
 * exercise daily/session/block aggregation instead of benchmarking only file I/O.
 */
function createUsageLine(index: number): string {
	const day = (index % 28) + 1;
	const hour = index % 24;
	const minute = Math.floor(index / 24) % 60;
	const timestamp = `2026-01-${day.toString().padStart(2, '0')}T${hour
		.toString()
		.padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00.000Z`;
	const suffix = index.toString(36).padStart(10, '0');
	const model = index % 5 === 0 ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514';
	const speed = index % 7 === 0 ? `,"speed":"fast"` : '';

	return `{"timestamp":"${timestamp}","cwd":"/tmp/ccusage-large-fixture","sessionId":"large-session","version":"1.0.0","message":{"id":"msg_${suffix}","model":"${model}","usage":{"input_tokens":${100 + (index % 1000)},"output_tokens":${20 + (index % 200)},"cache_creation_input_tokens":${index % 300},"cache_read_input_tokens":${index % 5000}${speed}}},"requestId":"req_${suffix}"}\n`;
}

const command = define({
	name: 'generate-large-fixture',
	description: 'Generate a synthetic Claude JSONL fixture for ccusage performance CI',
	toKebab: true,
	args: {
		outputDir: {
			type: 'string',
			required: true,
			description: 'Claude config directory to create',
		},
		sizeMib: {
			type: 'number',
			default: DEFAULT_SIZE_MIB,
			description: 'Target JSONL file size in MiB',
		},
	},
	async run(ctx) {
		if (!Number.isInteger(ctx.values.sizeMib) || ctx.values.sizeMib < 1) {
			throw new Error('--size-mib must be a positive integer');
		}

		const outputDir = resolve(ctx.values.outputDir);
		const projectDir = join(outputDir, 'projects', 'large-project', 'large-session');
		const outputFile = join(projectDir, 'chat.jsonl');
		const targetBytes = ctx.values.sizeMib * 1024 * 1024;

		await Bun.$`rm -rf ${outputDir}`;
		await Bun.$`mkdir -p ${projectDir}`;

		const writer = Bun.file(outputFile).writer();
		let writtenBytes = 0;
		let nextFlushAt = FLUSH_INTERVAL_BYTES;
		let lineIndex = 0;

		while (writtenBytes < targetBytes) {
			let chunk = '';
			for (
				let index = 0;
				index < CHUNK_LINE_COUNT && writtenBytes + chunk.length < targetBytes;
				index++
			) {
				chunk += createUsageLine(lineIndex++);
			}
			writer.write(chunk);
			writtenBytes += chunk.length;
			if (writtenBytes >= nextFlushAt) {
				await writer.flush();
				nextFlushAt += FLUSH_INTERVAL_BYTES;
			}
		}
		await writer.end();

		await Bun.write(
			Bun.stdout,
			`Generated ${outputFile}\nRows: ${lineIndex.toLocaleString('en-US')}\nSize: ${formatBytes(Bun.file(outputFile).size)}\n`,
		);
	},
});

await cli(Bun.argv.slice(2), command, {
	name: 'generate-large-fixture',
	description: 'Generate a synthetic Claude JSONL fixture for ccusage performance CI',
	renderHeader: null,
});
