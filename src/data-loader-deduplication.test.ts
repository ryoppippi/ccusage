import { describe, expect, it } from 'bun:test';
import { createFixture } from 'fs-fixture';
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
		it('should extract earliest timestamp from JSONL file', async () => {
			const content = [
				JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', message: { usage: {} } }),
				JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
				JSON.stringify({ timestamp: '2025-01-12T11:00:00Z', message: { usage: {} } }),
			].join('\n');

			await using fixture = await createFixture({
				'test.jsonl': content,
			});

			const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
			expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
		});

		it('should handle files without timestamps', async () => {
			const content = [
				JSON.stringify({ message: { usage: {} } }),
				JSON.stringify({ data: 'no timestamp' }),
			].join('\n');

			await using fixture = await createFixture({
				'test.jsonl': content,
			});

			const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
			expect(timestamp).toBeNull();
		});

		it('should skip invalid JSON lines', async () => {
			const content = [
				'invalid json',
				JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
				'{ broken: json',
			].join('\n');

			await using fixture = await createFixture({
				'test.jsonl': content,
			});

			const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
			expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
		});
	});

	describe('sortFilesByTimestamp', () => {
		it('should sort files by earliest timestamp', async () => {
			await using fixture = await createFixture({
				'file1.jsonl': JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }),
				'file2.jsonl': JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }),
				'file3.jsonl': JSON.stringify({ timestamp: '2025-01-12T10:00:00Z' }),
			});

			const file1 = fixture.getPath('file1.jsonl');
			const file2 = fixture.getPath('file2.jsonl');
			const file3 = fixture.getPath('file3.jsonl');

			const sorted = await sortFilesByTimestamp([file1, file2, file3]);

			expect(sorted).toEqual([file2, file3, file1]); // Chronological order
		});

		it('should place files without timestamps at the end', async () => {
			await using fixture = await createFixture({
				'file1.jsonl': JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }),
				'file2.jsonl': JSON.stringify({ no_timestamp: true }),
				'file3.jsonl': JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }),
			});

			const file1 = fixture.getPath('file1.jsonl');
			const file2 = fixture.getPath('file2.jsonl');
			const file3 = fixture.getPath('file3.jsonl');

			const sorted = await sortFilesByTimestamp([file1, file2, file3]);

			expect(sorted).toEqual([file3, file1, file2]); // file2 without timestamp goes to end
		});
	});

	describe('loadDailyUsageData with deduplication', () => {
		it('should deduplicate entries with same message and request IDs', async () => {
			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file1.jsonl': JSON.stringify({
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
							}),
						},
						session2: {
							'file2.jsonl': JSON.stringify({
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
							}),
						},
					},
				},
			});

			const data = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			// Should only have one entry for 2025-01-10
			expect(data).toHaveLength(1);
			expect(data[0]?.date).toBe('2025-01-10');
			expect(data[0]?.inputTokens).toBe(100);
			expect(data[0]?.outputTokens).toBe(50);
		});

		it('should process files in chronological order', async () => {
			await using fixture = await createFixture({
				projects: {
					'newer.jsonl': JSON.stringify({
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
					}),
					'older.jsonl': JSON.stringify({
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
					}),
				},
			});

			const data = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			// Should keep the older entry (100/50 tokens) not the newer one (200/100)
			expect(data).toHaveLength(1);
			expect(data[0]?.date).toBe('2025-01-10');
			expect(data[0]?.inputTokens).toBe(100);
			expect(data[0]?.outputTokens).toBe(50);
		});
	});

	describe('loadSessionData with deduplication', () => {
		it('should deduplicate entries across sessions', async () => {
			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file1.jsonl': JSON.stringify({
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
							}),
						},
						session2: {
							'file2.jsonl': JSON.stringify({
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
							}),
						},
					},
				},
			});

			const sessions = await loadSessionData({
				claudePath: fixture.path,
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
		});
	});
});
