#!/usr/bin/env bun

import { join, resolve } from 'node:path';
import { cli, define } from 'gunshi';

const DEFAULT_SIZE_MIB = 1024;
const CHUNK_LINE_COUNT = 128;
const FLUSH_INTERVAL_BYTES = 64 * 1024 * 1024;
const PADDING_SOURCE = 'x'.repeat(128 * 1024);

/**
 * Aggregate-only profile from a local large Claude corpus.
 *
 * No JSONL contents, prompts, paths, or model outputs are stored here. The source corpus had
 * 3,142 JSONL files, 1,238.97 MiB total, 403,203 rows, and about 3.2 KiB per row on average. File
 * sizes were heavily skewed: p50 105 KiB, p75 234 KiB, p90 654 KiB, p95 1.5 MiB, p99 5.4 MiB,
 * max 87 MiB. The generator scales only those aggregate distribution points to the requested
 * target size so CI exercises a realistic multi-file workload instead of one huge file.
 */
const REAL_WORLD_PROFILE = {
	files: 3142,
	totalMiB: 1238.9718046188354,
	quantiles: [
		{ p: 0, size: 236 },
		{ p: 0.5, size: 105267 },
		{ p: 0.75, size: 233572 },
		{ p: 0.9, size: 653972 },
		{ p: 0.95, size: 1504757 },
		{ p: 0.99, size: 5383751 },
		{ p: 1, size: 87033471 },
	],
};

/**
 * Formats generated fixture size for CI logs.
 */
function formatBytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Interpolates local aggregate file-size quantiles without storing any real Claude data.
 *
 * The CI fixture should behave like a real large Claude corpus: thousands of JSONL files, many
 * small sessions, and a long tail of larger sessions. A single 1 GiB file over-tests streaming,
 * while millions of tiny synthetic rows over-test per-line overhead.
 */
function interpolateFileSize(percentile: number): number {
	for (let index = 1; index < REAL_WORLD_PROFILE.quantiles.length; index++) {
		const previous = REAL_WORLD_PROFILE.quantiles[index - 1];
		const current = REAL_WORLD_PROFILE.quantiles[index];
		if (previous == null || current == null || percentile > current.p) {
			continue;
		}
		const span = current.p - previous.p;
		const ratio = span === 0 ? 0 : (percentile - previous.p) / span;
		return previous.size + (current.size - previous.size) * ratio;
	}
	return REAL_WORLD_PROFILE.quantiles.at(-1)?.size ?? 1024;
}

/**
 * Creates target file sizes by scaling the local aggregate distribution to the requested size.
 */
function createFileSizeTargets(targetBytes: number): number[] {
	const targetFileCount = Math.max(
		1,
		Math.round(
			(targetBytes / 1024 / 1024 / REAL_WORLD_PROFILE.totalMiB) * REAL_WORLD_PROFILE.files,
		),
	);
	const rawSizes = Array.from({ length: targetFileCount }, (_, index) =>
		interpolateFileSize((index + 0.5) / targetFileCount),
	);
	const rawTotal = rawSizes.reduce((total, size) => total + size, 0);
	const scale = targetBytes / rawTotal;
	return rawSizes.map((size) => Math.max(256, Math.round(size * scale)));
}

function shuffledIndex(index: number, length: number): number {
	return (index * (length - 1) + 17) % length;
}

function contentLength(index: number): number {
	if (index % 997 === 0) {
		return 48 * 1024 + (index % (32 * 1024));
	}
	if (index % 37 === 0) {
		return 8 * 1024 + (index % (8 * 1024));
	}
	return 1800 + (((index * 1103515245 + 12345) >>> 0) % 2400);
}

function contentPadding(length: number): string {
	return PADDING_SOURCE.slice(0, length);
}

/**
 * Creates one deterministic usage row that stays on ccusage's normal fast parser path.
 *
 * Every row has a unique message/request id so deduplication cannot collapse the synthetic
 * workload. The padded content keeps row density close to local real-world aggregate stats without
 * copying any user data into CI.
 */
function createUsageLine(index: number, fileIndex: number, sessionId: string): string {
	const day = (index % 28) + 1;
	const hour = index % 24;
	const minute = Math.floor(index / 24) % 60;
	const timestamp = `2026-01-${day.toString().padStart(2, '0')}T${hour
		.toString()
		.padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00.000Z`;
	const suffix = index.toString(36).padStart(10, '0');
	const model = index % 5 === 0 ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514';
	const speed = index % 7 === 0 ? `,"speed":"fast"` : '';
	const projectName = `project-${(fileIndex % 128).toString().padStart(3, '0')}`;
	const padding = contentPadding(contentLength(index));

	return `{"timestamp":"${timestamp}","cwd":"/tmp/ccusage-large-fixture/${projectName}","sessionId":"${sessionId}","version":"1.0.0","message":{"id":"msg_${suffix}","model":"${model}","content":[{"type":"text","text":"${padding}"}],"usage":{"input_tokens":${100 + (index % 1000)},"output_tokens":${20 + (index % 200)},"cache_creation_input_tokens":${index % 300},"cache_read_input_tokens":${index % 5000}${speed}}},"requestId":"req_${suffix}"}\n`;
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
		const targetBytes = ctx.values.sizeMib * 1024 * 1024;
		const fileSizeTargets = createFileSizeTargets(targetBytes);

		await Bun.$`rm -rf ${outputDir}`;

		let totalBytes = 0;
		let lineIndex = 0;
		let fileCount = 0;
		const createdProjectDirs = new Set<string>();

		for (let fileIndex = 0; fileIndex < fileSizeTargets.length; fileIndex++) {
			const targetSize = fileSizeTargets[shuffledIndex(fileIndex, fileSizeTargets.length)] ?? 1024;
			const projectDir = join(
				outputDir,
				'projects',
				`project-${(fileIndex % 128).toString().padStart(3, '0')}`,
			);
			if (!createdProjectDirs.has(projectDir)) {
				await Bun.$`mkdir -p ${projectDir}`;
				createdProjectDirs.add(projectDir);
			}
			const sessionId = `session-${fileIndex.toString().padStart(6, '0')}`;
			const outputFile = join(projectDir, `${sessionId}.jsonl`);
			const writer = Bun.file(outputFile).writer();
			let fileBytes = 0;
			let nextFlushAt = FLUSH_INTERVAL_BYTES;

			while (fileBytes < targetSize) {
				let chunk = '';
				for (
					let index = 0;
					index < CHUNK_LINE_COUNT && fileBytes + chunk.length < targetSize;
					index++
				) {
					chunk += createUsageLine(lineIndex++, fileIndex, sessionId);
				}
				writer.write(chunk);
				fileBytes += chunk.length;
				totalBytes += chunk.length;
				if (fileBytes >= nextFlushAt) {
					await writer.flush();
					nextFlushAt += FLUSH_INTERVAL_BYTES;
				}
			}
			await writer.end();
			fileCount++;
		}

		await Bun.write(
			Bun.stdout,
			`Generated ${outputDir}\nFiles: ${fileCount.toLocaleString('en-US')}\nRows: ${lineIndex.toLocaleString('en-US')}\nSize: ${formatBytes(totalBytes)}\n`,
		);
	},
});

await cli(Bun.argv.slice(2), command, {
	name: 'generate-large-fixture',
	description: 'Generate a synthetic Claude JSONL fixture for ccusage performance CI',
	renderHeader: null,
});
