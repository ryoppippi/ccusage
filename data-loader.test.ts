import { beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createFixture } from "fs-fixture";
import {
	type UsageData,
	formatDate,
	loadSessionData,
	loadUsageData,
} from "./data-loader.ts";
import { clearPricingCache } from "./pricing-fetcher.ts";

describe("formatDate", () => {
	test("formats UTC timestamp to local date", () => {
		// Test with UTC timestamps - results depend on local timezone
		expect(formatDate("2024-01-01T00:00:00Z")).toBe("2024-01-01");
		expect(formatDate("2024-12-31T23:59:59Z")).toBe("2024-12-31");
	});

	test("handles various date formats", () => {
		expect(formatDate("2024-01-01")).toBe("2024-01-01");
		expect(formatDate("2024-01-01T12:00:00")).toBe("2024-01-01");
		expect(formatDate("2024-01-01T12:00:00.000Z")).toBe("2024-01-01");
	});

	test("pads single digit months and days", () => {
		expect(formatDate("2024-01-05T00:00:00Z")).toBe("2024-01-05");
		expect(formatDate("2024-10-01T00:00:00Z")).toBe("2024-10-01");
	});
});

describe("loadUsageData", () => {
	test("returns empty array when no files found", async () => {
		await using fixture = await createFixture({
			projects: {},
		});

		const result = await loadUsageData({ claudePath: fixture.path });
		expect(result).toEqual([]);
	});

	test("aggregates daily usage data correctly", async () => {
		const mockData1: UsageData[] = [
			{
				timestamp: "2024-01-01T00:00:00Z",
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: "2024-01-01T12:00:00Z",
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
		];

		const mockData2: UsageData[] = [
			{
				timestamp: "2024-01-02T00:00:00Z",
				message: { usage: { input_tokens: 150, output_tokens: 75 } },
				costUSD: 0.015,
			},
			{
				timestamp: "2024-01-03T00:00:00Z",
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						"file1.jsonl": mockData1.map((d) => JSON.stringify(d)).join("\n"),
					},
				},
				project2: {
					session2: {
						"file2.jsonl": mockData2.map((d) => JSON.stringify(d)).join("\n"),
					},
				},
			},
		});

		const result = await loadUsageData({ claudePath: fixture.path });

		// Should have 3 days of data
		expect(result).toHaveLength(3);

		// Check aggregation for 2024-01-01
		const day1 = result.find((r) => r.date === "2024-01-01");
		expect(day1?.inputTokens).toBe(300); // 100 + 200
		expect(day1?.outputTokens).toBe(150); // 50 + 100
		expect(day1?.totalCost).toBe(0.03); // 0.01 + 0.02
	});

	test("aggregates cache tokens correctly", async () => {
		const mockData: UsageData[] = [
			{
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 25,
						cache_read_input_tokens: 15,
					},
				},
				costUSD: 0.01,
			},
			{
				timestamp: "2024-01-01T12:00:00Z",
				message: {
					usage: {
						input_tokens: 200,
						output_tokens: 100,
						cache_creation_input_tokens: 50,
						cache_read_input_tokens: 30,
					},
				},
				costUSD: 0.02,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						"file.jsonl": mockData.map((d) => JSON.stringify(d)).join("\n"),
					},
				},
			},
		});

		const result = await loadUsageData({ claudePath: fixture.path });

		expect(result).toHaveLength(1);
		const day = result[0];
		expect(day?.cacheCreationTokens).toBe(75); // 25 + 50
		expect(day?.cacheReadTokens).toBe(45); // 15 + 30
	});

	test("filters by date range", async () => {
		const mockData: UsageData[] = [
			{
				timestamp: "2024-01-01T00:00:00Z",
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: "2024-01-15T00:00:00Z",
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: "2024-02-01T00:00:00Z",
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						"file.jsonl": mockData.map((d) => JSON.stringify(d)).join("\n"),
					},
				},
			},
		});

		const result = await loadUsageData({
			claudePath: fixture.path,
			since: "20240110",
			until: "20240125",
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.date).toBe("2024-01-15");
	});

	test("handles invalid JSON lines gracefully", async () => {
		const mockData = `
{"timestamp":"2024-01-01T00:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
invalid json line
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":200,"output_tokens":100}},"costUSD":0.02}
{invalid json}
{"timestamp":"2024-01-01T18:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						"file.jsonl": mockData,
					},
				},
			},
		});

		const result = await loadUsageData({ claudePath: fixture.path });

		// Should only process valid lines
		expect(result).toHaveLength(1);
		expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
		expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
	});

	test("skips data without required fields", async () => {
		const mockData = `
{"timestamp":"2024-01-01T00:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{}}}
{"timestamp":"2024-01-01T18:00:00Z","message":{}}
{"timestamp":"2024-01-01T20:00:00Z"}
{"message":{"usage":{"input_tokens":200,"output_tokens":100}}}
{"timestamp":"2024-01-01T22:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						"file.jsonl": mockData,
					},
				},
			},
		});

		const result = await loadUsageData({ claudePath: fixture.path });

		// Should only include valid entries
		expect(result).toHaveLength(1);
		expect(result[0]?.inputTokens).toBe(400); // 100 + 300
		expect(result[0]?.totalCost).toBe(0.04); // 0.01 + 0.03
	});
});

describe("loadSessionData", () => {
	test("returns empty array when no files found", async () => {
		await using fixture = await createFixture({
			projects: {},
		});

		const result = await loadSessionData({ claudePath: fixture.path });
		expect(result).toEqual([]);
	});

	test("extracts session info from file paths", async () => {
		const mockData: UsageData = {
			timestamp: "2024-01-01T00:00:00Z",
			message: { usage: { input_tokens: 100, output_tokens: 50 } },
			costUSD: 0.01,
		};

		await using fixture = await createFixture({
			projects: {
				"project1/subfolder": {
					session123: {
						"chat.jsonl": JSON.stringify(mockData),
					},
				},
				project2: {
					session456: {
						"chat.jsonl": JSON.stringify(mockData),
					},
				},
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		expect(result).toHaveLength(2);
		expect(result.find((s) => s.sessionId === "session123")).toBeTruthy();
		expect(
			result.find((s) => s.projectPath === "project1/subfolder"),
		).toBeTruthy();
		expect(result.find((s) => s.sessionId === "session456")).toBeTruthy();
		expect(result.find((s) => s.projectPath === "project2")).toBeTruthy();
	});

	test("aggregates session usage data", async () => {
		const mockData: UsageData[] = [
			{
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 10,
						cache_read_input_tokens: 5,
					},
				},
				costUSD: 0.01,
			},
			{
				timestamp: "2024-01-01T12:00:00Z",
				message: {
					usage: {
						input_tokens: 200,
						output_tokens: 100,
						cache_creation_input_tokens: 20,
						cache_read_input_tokens: 10,
					},
				},
				costUSD: 0.02,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						"chat.jsonl": mockData.map((d) => JSON.stringify(d)).join("\n"),
					},
				},
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		expect(result).toHaveLength(1);
		const session = result[0];
		expect(session?.inputTokens).toBe(300); // 100 + 200
		expect(session?.outputTokens).toBe(150); // 50 + 100
		expect(session?.cacheCreationTokens).toBe(30); // 10 + 20
		expect(session?.cacheReadTokens).toBe(15); // 5 + 10
		expect(session?.totalCost).toBe(0.03); // 0.01 + 0.02
		expect(session?.lastActivity).toBe("2024-01-01");
	});

	test("sorts sessions by total cost descending", async () => {
		const sessions = [
			{
				sessionId: "session1",
				data: {
					timestamp: "2024-01-01T00:00:00Z",
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: "session2",
				data: {
					timestamp: "2024-01-01T00:00:00Z",
					message: { usage: { input_tokens: 500, output_tokens: 250 } },
					costUSD: 0.05,
				},
			},
			{
				sessionId: "session3",
				data: {
					timestamp: "2024-01-01T00:00:00Z",
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: Object.fromEntries(
					sessions.map((s) => [
						s.sessionId,
						{ "chat.jsonl": JSON.stringify(s.data) },
					]),
				),
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		expect(result).toHaveLength(3);
		expect(result[0]?.sessionId).toBe("session2");
		expect(result[0]?.totalCost).toBe(0.05);
		expect(result[1]?.sessionId).toBe("session3");
		expect(result[1]?.totalCost).toBe(0.02);
		expect(result[2]?.sessionId).toBe("session1");
		expect(result[2]?.totalCost).toBe(0.01);
	});

	test("filters sessions by date range", async () => {
		const sessions = [
			{
				sessionId: "session1",
				data: {
					timestamp: "2024-01-15T00:00:00Z",
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: "session2",
				data: {
					timestamp: "2024-02-01T00:00:00Z",
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: Object.fromEntries(
					sessions.map((s) => [
						s.sessionId,
						{ "chat.jsonl": JSON.stringify(s.data) },
					]),
				),
			},
		});

		const result = await loadSessionData({
			claudePath: fixture.path,
			since: "20240110",
			until: "20240125",
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.lastActivity).toBe("2024-01-15");
	});
});

describe("data-loader cost calculation with real pricing", () => {
	beforeEach(() => {
		clearPricingCache();
	});

	describe("loadUsageData with mixed schemas", () => {
		test("should handle old schema with costUSD", async () => {
			const oldData = {
				timestamp: "2024-01-15T10:00:00Z",
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
					},
				},
				costUSD: 0.05, // Pre-calculated cost
			};

			await using fixture = await createFixture({
				projects: {
					"test-project-old": {
						"session-old": {
							"usage.jsonl": `${JSON.stringify(oldData)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe("2024-01-15");
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.totalCost).toBe(0.05);
		});

		test("should calculate cost for new schema with claude-3-5-sonnet-20241022", async () => {
			// Use a well-known Claude model
			const modelName = "claude-3-5-sonnet-20241022";

			const newData = {
				timestamp: "2024-01-16T10:00:00Z",
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 200,
						cache_read_input_tokens: 300,
					},
					model: modelName,
				},
			};

			await using fixture = await createFixture({
				projects: {
					"test-project-new": {
						"session-new": {
							"usage.jsonl": `${JSON.stringify(newData)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe("2024-01-16");
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(200);
			expect(results[0]?.cacheReadTokens).toBe(300);

			// Should have calculated some cost
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});

		test("should handle mixed data in same file", async () => {
			const data1 = {
				timestamp: "2024-01-17T10:00:00Z",
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			};

			const data2 = {
				timestamp: "2024-01-17T11:00:00Z",
				message: {
					usage: { input_tokens: 200, output_tokens: 100 },
					model: "claude-3-5-sonnet-20241022",
				},
			};

			const data3 = {
				timestamp: "2024-01-17T12:00:00Z",
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				// No costUSD and no model - should be 0 cost
			};

			await using fixture = await createFixture({
				projects: {
					"test-project-mixed": {
						"session-mixed": {
							"usage.jsonl": `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n${JSON.stringify(data3)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe("2024-01-17");
			expect(results[0]?.inputTokens).toBe(600); // 100 + 200 + 300
			expect(results[0]?.outputTokens).toBe(300); // 50 + 100 + 150

			// Total cost should be at least the pre-calculated cost from data1
			expect(results[0]?.totalCost).toBeGreaterThanOrEqual(0.01);
		});

		test("should handle data without model or costUSD", async () => {
			const data = {
				timestamp: "2024-01-18T10:00:00Z",
				message: { usage: { input_tokens: 500, output_tokens: 250 } },
				// No costUSD and no model
			};

			await using fixture = await createFixture({
				projects: {
					"test-project-no-cost": {
						"session-no-cost": {
							"usage.jsonl": `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe("2024-01-18");
			expect(results[0]?.inputTokens).toBe(500);
			expect(results[0]?.outputTokens).toBe(250);
			expect(results[0]?.totalCost).toBe(0); // No cost since no model or costUSD
		});
	});

	describe("loadSessionData with mixed schemas", () => {
		test("should calculate costs correctly for sessions", async () => {
			const session1Data = {
				timestamp: "2024-01-15T10:00:00Z",
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
				costUSD: 0.05,
			};

			const session2Data = {
				timestamp: "2024-01-16T10:00:00Z",
				message: {
					usage: { input_tokens: 2000, output_tokens: 1000 },
					model: "claude-3-5-sonnet-20241022",
				},
			};

			await using fixture = await createFixture({
				projects: {
					"test-project": {
						session1: {
							"usage.jsonl": JSON.stringify(session1Data),
						},
						session2: {
							"usage.jsonl": JSON.stringify(session2Data),
						},
					},
				},
			});

			const results = await loadSessionData({ claudePath: fixture.path });

			expect(results).toHaveLength(2);

			// Check session 1
			const session1 = results.find((s) => s.sessionId === "session1");
			expect(session1).toBeTruthy();
			expect(session1?.totalCost).toBe(0.05);

			// Check session 2
			const session2 = results.find((s) => s.sessionId === "session2");
			expect(session2).toBeTruthy();
			expect(session2?.totalCost).toBeGreaterThan(0);
		});

		test("should handle unknown models gracefully", async () => {
			const data = {
				timestamp: "2024-01-19T10:00:00Z",
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: "unknown-model-xyz",
				},
			};

			await using fixture = await createFixture({
				projects: {
					"test-project-unknown": {
						"session-unknown": {
							"usage.jsonl": `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadSessionData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.totalCost).toBe(0); // 0 cost for unknown model
		});
	});

	describe("cached tokens cost calculation", () => {
		test("should correctly calculate costs for all token types with claude-3-5-sonnet-20241022", async () => {
			const data = {
				timestamp: "2024-01-20T10:00:00Z",
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 2000,
						cache_read_input_tokens: 1500,
					},
					model: "claude-3-5-sonnet-20241022",
				},
			};

			await using fixture = await createFixture({
				projects: {
					"test-project-cache": {
						"session-cache": {
							"usage.jsonl": `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe("2024-01-20");
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(2000);
			expect(results[0]?.cacheReadTokens).toBe(1500);

			// Cost should be calculated from all token types
			expect(results[0]?.totalCost).toBeGreaterThan(0);

			// Rough calculation check:
			// - Input: 1000 tokens at $3/1M = $0.003
			// - Output: 500 tokens at $15/1M = $0.0075
			// - Cache creation: 2000 tokens at $3.75/1M = $0.0075
			// - Cache read: 1500 tokens at $0.30/1M = $0.00045
			// Total: ~$0.01845
			expect(results[0]?.totalCost).toBeCloseTo(0.01845, 4);
		});
	});
});
