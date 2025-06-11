import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	createUniqueHash,
	getEarliestTimestamp,
	loadDailyUsageData,
	loadSessionData,
	sortFilesByTimestamp,
} from './data-loader.ts';

describe('deduplication functionality', () => {
	describe('createUniqueHash', () => {
		it('should create hash from message id and request id', () => {
			const data = {
				timestamp: '2025-01-10T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
			};

			const hash = createUniqueHash(data);
			expect(hash).toBe('msg_123:req_456');
		});

		it('should return null when message id is missing', () => {
			const data = {
				timestamp: '2025-01-10T10:00:00Z',
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
			};

			const hash = createUniqueHash(data);
			expect(hash).toBeNull();
		});

		it('should return null when request id is missing', () => {
			const data = {
				timestamp: '2025-01-10T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
			};

			const hash = createUniqueHash(data);
			expect(hash).toBeNull();
		});
	});

	describe('getEarliestTimestamp', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), 'ccusage-test-'));
		});

		afterEach(async () => {
			if (tempDir != null) {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it('should extract earliest timestamp from JSONL file', async () => {
			const testFile = path.join(tempDir, 'test.jsonl');

			const content = [
				JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', message: { usage: {} } }),
				JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
				JSON.stringify({ timestamp: '2025-01-12T11:00:00Z', message: { usage: {} } }),
			].join('\n');

			await writeFile(testFile, content);

			const timestamp = await getEarliestTimestamp(testFile);
			expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
		});

		it('should handle files without timestamps', async () => {
			const testFile = path.join(tempDir, 'test.jsonl');

			const content = [
				JSON.stringify({ message: { usage: {} } }),
				JSON.stringify({ data: 'no timestamp' }),
			].join('\n');

			await writeFile(testFile, content);

			const timestamp = await getEarliestTimestamp(testFile);
			expect(timestamp).toBeNull();
		});

		it('should skip invalid JSON lines', async () => {
			const testFile = path.join(tempDir, 'test.jsonl');

			const content = [
				'invalid json',
				JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
				'{ broken: json',
			].join('\n');

			await writeFile(testFile, content);

			const timestamp = await getEarliestTimestamp(testFile);
			expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
		});
	});

	describe('sortFilesByTimestamp', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), 'ccusage-test-'));
		});

		afterEach(async () => {
			if (tempDir != null) {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it('should sort files by earliest timestamp', async () => {
			const file1 = path.join(tempDir, 'file1.jsonl');
			const file2 = path.join(tempDir, 'file2.jsonl');
			const file3 = path.join(tempDir, 'file3.jsonl');

			// File 1: earliest timestamp 2025-01-15
			await writeFile(file1, JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }));

			// File 2: earliest timestamp 2025-01-10
			await writeFile(file2, JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }));

			// File 3: earliest timestamp 2025-01-12
			await writeFile(file3, JSON.stringify({ timestamp: '2025-01-12T10:00:00Z' }));

			const sorted = await sortFilesByTimestamp([file1, file2, file3]);

			expect(sorted).toEqual([file2, file3, file1]); // Chronological order
		});

		it('should place files without timestamps at the end', async () => {
			const file1 = path.join(tempDir, 'file1.jsonl');
			const file2 = path.join(tempDir, 'file2.jsonl');
			const file3 = path.join(tempDir, 'file3.jsonl');

			await writeFile(file1, JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }));
			await writeFile(file2, JSON.stringify({ no_timestamp: true }));
			await writeFile(file3, JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }));

			const sorted = await sortFilesByTimestamp([file1, file2, file3]);

			expect(sorted).toEqual([file3, file1, file2]); // file2 without timestamp goes to end
		});
	});

	describe('loadDailyUsageData with deduplication', () => {
		let tempDir: string;

		it('should deduplicate entries with same message and request IDs', async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), 'ccusage-test-'));
			const projectDir = path.join(tempDir, 'projects');
			const session1Dir = path.join(projectDir, 'project1', 'session1');
			const session2Dir = path.join(projectDir, 'project1', 'session2');

			await mkdir(session1Dir, { recursive: true });
			await writeFile(path.join(session1Dir, 'file1.jsonl'), JSON.stringify({
				timestamp: '2025-01-10T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
				costUSD: 0.001,
			}));

			// Duplicate entry in a later session
			await mkdir(session2Dir, { recursive: true });
			await writeFile(path.join(session2Dir, 'file2.jsonl'), JSON.stringify({
				timestamp: '2025-01-15T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
				costUSD: 0.001,
			}));

			const data = await loadDailyUsageData({
				claudePath: tempDir,
				mode: 'display',
			});

			// Should only have one entry for 2025-01-10
			expect(data).toHaveLength(1);
			expect(data[0]?.date).toBe('2025-01-10');
			expect(data[0]?.inputTokens).toBe(100);
			expect(data[0]?.outputTokens).toBe(50);

			await rm(tempDir, { recursive: true });
		});

		it('should process files in chronological order', async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), 'ccusage-test-'));
			const projectDir = path.join(tempDir, 'projects');

			// Create files with different timestamps but same message/request IDs
			const newerFile = path.join(projectDir, 'newer.jsonl');
			const olderFile = path.join(projectDir, 'older.jsonl');

			// Newer file has an earlier entry in the file
			await mkdir(projectDir, { recursive: true });
			await writeFile(newerFile, JSON.stringify({
				timestamp: '2025-01-15T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 200,
						output_tokens: 100,
					},
				},
				requestId: 'req_456',
				costUSD: 0.002,
			}));

			// Older file has the original entry
			await writeFile(olderFile, JSON.stringify({
				timestamp: '2025-01-10T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
				costUSD: 0.001,
			}));

			const data = await loadDailyUsageData({
				claudePath: tempDir,
				mode: 'display',
			});

			// Should keep the older entry (100/50 tokens) not the newer one (200/100)
			expect(data).toHaveLength(1);
			expect(data[0]?.date).toBe('2025-01-10');
			expect(data[0]?.inputTokens).toBe(100);
			expect(data[0]?.outputTokens).toBe(50);

			await rm(tempDir, { recursive: true });
		});
	});

	describe('loadSessionData with deduplication', () => {
		let tempDir: string;

		it('should deduplicate entries across sessions', async () => {
			tempDir = await mkdtemp(path.join(tmpdir(), 'ccusage-test-'));
			const projectDir = path.join(tempDir, 'projects');
			const session1Dir = path.join(projectDir, 'project1', 'session1');
			const session2Dir = path.join(projectDir, 'project1', 'session2');

			await mkdir(session1Dir, { recursive: true });
			await writeFile(path.join(session1Dir, 'file1.jsonl'), JSON.stringify({
				timestamp: '2025-01-10T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
				costUSD: 0.001,
			}));

			// Duplicate entry in session2
			await mkdir(session2Dir, { recursive: true });
			await writeFile(path.join(session2Dir, 'file2.jsonl'), JSON.stringify({
				timestamp: '2025-01-15T10:00:00Z',
				message: {
					id: 'msg_123',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
				requestId: 'req_456',
				costUSD: 0.001,
			}));

			const sessions = await loadSessionData({
				claudePath: tempDir,
				mode: 'display',
			});

			// Session 1 should have the entry
			const session1 = sessions.find(s => s.sessionId === 'session1');
			expect(session1).toBeDefined();
			expect(session1?.inputTokens).toBe(100);
			expect(session1?.outputTokens).toBe(50);

			// Session 2 should either not exist or have 0 tokens (duplicate was skipped)
			const session2 = sessions.find(s => s.sessionId === 'session2');
			if (session2 != null) {
				expect(session2.inputTokens).toBe(0);
				expect(session2.outputTokens).toBe(0);
			}
			else {
				// It's also valid for session2 to not be included if it has no entries
				expect(sessions.length).toBe(1);
			}

			await rm(tempDir, { recursive: true });
		});
	});
});
