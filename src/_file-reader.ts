/**
 * @fileoverview Streaming file reader for handling large JSONL files
 * 
 * This module provides utilities for reading large JSONL files line-by-line
 * using streams to avoid memory issues with very large files.
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { logger } from './logger.ts';

/**
 * Maximum file size (in bytes) to read into memory at once
 * Files larger than this will be streamed line-by-line
 * 100MB should be safe for most systems
 */
const MAX_FILE_SIZE_FOR_MEMORY = 100 * 1024 * 1024; // 100MB

/**
 * Read a file and process it line by line
 * Automatically chooses between in-memory and streaming based on file size
 * 
 * @param filePath - Path to the file to read
 * @param stats - Optional file stats (to avoid extra stat call)
 * @returns Array of non-empty lines from the file
 */
export async function readFileLines(filePath: string, stats?: { size: number }): Promise<string[]> {
	// Get file size if not provided
	const fileSize = stats?.size ?? (await import('node:fs/promises').then(fs => fs.stat(filePath))).size;
	
	// For small files, use the original in-memory approach
	if (fileSize < MAX_FILE_SIZE_FOR_MEMORY) {
		logger.debug(`Reading file in-memory: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
		const content = await readFile(filePath, 'utf-8');
		return content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);
	}
	
	// For large files, use streaming approach
	logger.debug(`Streaming large file: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
	return streamFileLines(filePath);
}

/**
 * Stream a file line by line to handle very large files
 * 
 * @param filePath - Path to the file to stream
 * @returns Array of non-empty lines from the file
 */
async function streamFileLines(filePath: string): Promise<string[]> {
	const lines: string[] = [];
	
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { encoding: 'utf-8' });
		const rl = createInterface({
			input: stream,
			crlfDelay: Infinity, // Handle Windows line endings
		});
		
		rl.on('line', (line) => {
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				lines.push(trimmed);
			}
		});
		
		rl.on('close', () => {
			resolve(lines);
		});
		
		rl.on('error', (error) => {
			reject(error);
		});
		
		stream.on('error', (error) => {
			reject(error);
		});
	});
}

/**
 * Process a file line by line with a callback
 * Useful for processing without loading all lines into memory
 * 
 * @param filePath - Path to the file to process
 * @param processor - Callback function to process each line
 * @param stats - Optional file stats (to avoid extra stat call)
 */
export async function processFileLines(
	filePath: string,
	processor: (line: string) => void | Promise<void>,
	stats?: { size: number }
): Promise<void> {
	// Get file size if not provided
	const fileSize = stats?.size ?? (await import('node:fs/promises').then(fs => fs.stat(filePath))).size;
	
	// For small files, use the original in-memory approach
	if (fileSize < MAX_FILE_SIZE_FOR_MEMORY) {
		logger.debug(`Processing file in-memory: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
		const content = await readFile(filePath, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);
		
		for (const line of lines) {
			await processor(line);
		}
		return;
	}
	
	// For large files, use streaming approach
	logger.debug(`Streaming large file for processing: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
	
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { encoding: 'utf-8' });
		const rl = createInterface({
			input: stream,
			crlfDelay: Infinity,
		});
		
		rl.on('line', async (line) => {
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				try {
					await processor(trimmed);
				} catch (error) {
					// Log but continue processing other lines
					logger.debug(`Error processing line: ${String(error)}`);
				}
			}
		});
		
		rl.on('close', () => {
			resolve();
		});
		
		rl.on('error', (error) => {
			reject(error);
		});
		
		stream.on('error', (error) => {
			reject(error);
		});
	});
}