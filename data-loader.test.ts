import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createFixture } from "fs-fixture";
import { glob } from "tinyglobby";
import {
	type UsageData,
	formatDate,
	loadSessionData,
	loadUsageData,
} from "./data-loader.ts";
import { clearPricingCache } from "./pricing-fetcher.ts";

mock.module("node:fs/promises", () => ({
	readFile: mock(() => Promise.resolve("")),
}));

mock.module("tinyglobby", () => ({
	glob: mock(() => Promise.resolve([])),
}));

mock.module("node:os", () => ({
	homedir: mock(() => "/home/test"),
}));

describe("formatDate", () => {
	test("formats UTC timestamp to local date", () => {
		// Test with UTC timestamps - results depend on local timezone
		expect(formatDate("2024-01-01T00:00:00Z")).toBe("2024-01-01");
		expect(formatDate("2024-01-01T15:00:00Z")).toBe("2024-01-01");
	});

	test("handles various date formats", () => {
		expect(formatDate("2024-12-25T10:30:00Z")).toBe("2024-12-25");
		expect(formatDate("2024-02-29T00:00:00Z")).toBe("2024-02-29"); // Leap year
	});

	test("pads single digit months and days", () => {
		expect(formatDate("2024-01-05T00:00:00Z")).toBe("2024-01-05");
		expect(formatDate("2024-10-01T00:00:00Z")).toBe("2024-10-01");
	});
});

describe("loadUsageData", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns empty array when no files found", async () => {
		const mockGlob = mock(() => Promise.resolve([]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const result = await loadUsageData();
		expect(result).toEqual([]);
		expect(mockGlob).toHaveBeenCalledWith(["**/*.jsonl"], {
			cwd: path.join("/home/test", ".claude", "projects"),
			absolute: true,
		});
	});

	test("uses custom claude path when provided", async () => {
		const mockGlob = mock(() => Promise.resolve([]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		await loadUsageData({ claudePath: "/custom/path" });
		expect(mockGlob).toHaveBeenCalledWith(["**/*.jsonl"], {
			cwd: "/custom/path/projects",
			absolute: true,
		});
	});

	test("aggregates daily usage data correctly", async () => {
		const mockGlob = mock(() =>
			Promise.resolve(["/test/file1.jsonl", "/test/file2.jsonl"]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

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

		const mockReadFile = mock((file: string) => {
			if (file === "/test/file1.jsonl") {
				return Promise.resolve(
					mockData1.map((d) => JSON.stringify(d)).join("\n"),
				);
			}
			return Promise.resolve(
				mockData2.map((d) => JSON.stringify(d)).join("\n"),
			);
		});
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadUsageData();

		expect(result).toHaveLength(3);
		// Should be sorted by date descending
		expect(result[0]).toEqual({
			date: "2024-01-03",
			inputTokens: 300,
			outputTokens: 150,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.03,
		});
		expect(result[1]).toEqual({
			date: "2024-01-02",
			inputTokens: 150,
			outputTokens: 75,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.015,
		});
		expect(result[2]).toEqual({
			date: "2024-01-01",
			inputTokens: 300, // 100 + 200
			outputTokens: 150, // 50 + 100
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.03, // 0.01 + 0.02
		});
	});

	test("aggregates cache tokens correctly", async () => {
		const mockGlob = mock(() => Promise.resolve(["/test/file.jsonl"]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockData: UsageData[] = [
			{
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 200,
						cache_read_input_tokens: 300,
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
						cache_creation_input_tokens: 150,
						cache_read_input_tokens: 250,
					},
				},
				costUSD: 0.02,
			},
		];

		const mockReadFile = mock(() =>
			Promise.resolve(mockData.map((d) => JSON.stringify(d)).join("\n")),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadUsageData();

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			date: "2024-01-01",
			inputTokens: 300, // 100 + 200
			outputTokens: 150, // 50 + 100
			cacheCreationTokens: 350, // 200 + 150
			cacheReadTokens: 550, // 300 + 250
			totalCost: 0.03, // 0.01 + 0.02
		});
	});

	test("filters by date range", async () => {
		const mockGlob = mock(() => Promise.resolve(["/test/file.jsonl"]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

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

		const mockReadFile = mock(() =>
			Promise.resolve(mockData.map((d) => JSON.stringify(d)).join("\n")),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadUsageData({
			since: "20240110",
			until: "20240125",
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.date).toBe("2024-01-15");
	});

	test("handles invalid JSON lines gracefully", async () => {
		const mockGlob = mock(() => Promise.resolve(["/test/file.jsonl"]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockContent = `{"timestamp": "2024-01-01T00:00:00Z", "message": {"usage": {"input_tokens": 100, "output_tokens": 50}}, "costUSD": 0.01}
invalid json line
{"timestamp": "2024-01-02T00:00:00Z", "message": {"usage": {"input_tokens": 200, "output_tokens": 100}}, "costUSD": 0.02}
`;

		const mockReadFile = mock(() => Promise.resolve(mockContent));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadUsageData();
		expect(result).toHaveLength(2);
	});

	test("skips data without required fields", async () => {
		const mockGlob = mock(() => Promise.resolve(["/test/file.jsonl"]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockContent = `{"timestamp": "2024-01-01T00:00:00Z", "message": {"usage": {"input_tokens": 100, "output_tokens": 50}}, "costUSD": 0.01}
{"timestamp": "2024-01-02T00:00:00Z"}
{"message": {"usage": {"input_tokens": 200, "output_tokens": 100}}, "costUSD": 0.02}
{"timestamp": "2024-01-03T00:00:00Z", "message": {}, "costUSD": 0.03}
`;

		const mockReadFile = mock(() => Promise.resolve(mockContent));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadUsageData();
		expect(result).toHaveLength(1);
		expect(result[0]?.date).toBe("2024-01-01");
	});
});

describe("loadSessionData", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns empty array when no files found", async () => {
		const mockGlob = mock(() => Promise.resolve([]));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const result = await loadSessionData();
		expect(result).toEqual([]);
	});

	test("extracts session info from file paths", async () => {
		const basePath = path.join("/home/test", ".claude", "projects");
		const mockGlob = mock(() =>
			Promise.resolve([
				path.join(
					basePath,
					"project1",
					"subfolder",
					"session123",
					"chat.jsonl",
				),
				path.join(basePath, "project2", "session456", "chat.jsonl"),
			]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockData: UsageData = {
			timestamp: "2024-01-01T00:00:00Z",
			message: { usage: { input_tokens: 100, output_tokens: 50 } },
			costUSD: 0.01,
		};

		const mockReadFile = mock(() => Promise.resolve(JSON.stringify(mockData)));
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadSessionData();

		expect(result).toHaveLength(2);
		expect(result[0]?.sessionId).toBe("session123");
		expect(result[0]?.projectPath).toBe(path.join("project1", "subfolder"));
		expect(result[1]?.sessionId).toBe("session456");
		expect(result[1]?.projectPath).toBe("project2");
	});

	test("aggregates session usage data", async () => {
		const basePath = path.join("/home/test", ".claude", "projects");
		const mockGlob = mock(() =>
			Promise.resolve([
				path.join(basePath, "project1", "session123", "chat.jsonl"),
			]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockData: UsageData[] = [
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
			{
				timestamp: "2024-01-02T00:00:00Z",
				message: { usage: { input_tokens: 150, output_tokens: 75 } },
				costUSD: 0.015,
			},
		];

		const mockReadFile = mock(() =>
			Promise.resolve(mockData.map((d) => JSON.stringify(d)).join("\n")),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadSessionData();

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			sessionId: "session123",
			projectPath: "project1",
			inputTokens: 450, // 100 + 200 + 150
			outputTokens: 225, // 50 + 100 + 75
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.045, // 0.01 + 0.02 + 0.015
			lastActivity: "2024-01-02",
		});
	});

	test("sorts sessions by total cost descending", async () => {
		const basePath = path.join("/home/test", ".claude", "projects");
		const mockGlob = mock(() =>
			Promise.resolve([
				path.join(basePath, "project1", "session1", "chat.jsonl"),
				path.join(basePath, "project2", "session2", "chat.jsonl"),
				path.join(basePath, "project3", "session3", "chat.jsonl"),
			]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockReadFile = mock((file: string) => {
			if (file.includes("session1")) {
				return Promise.resolve(
					JSON.stringify({
						timestamp: "2024-01-01T00:00:00Z",
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.05,
					}),
				);
			}
			if (file.includes("session2")) {
				return Promise.resolve(
					JSON.stringify({
						timestamp: "2024-01-01T00:00:00Z",
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.1,
					}),
				);
			}
			return Promise.resolve(
				JSON.stringify({
					timestamp: "2024-01-01T00:00:00Z",
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.02,
				}),
			);
		});
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadSessionData();

		expect(result).toHaveLength(3);
		expect(result[0]?.totalCost).toBe(0.1);
		expect(result[1]?.totalCost).toBe(0.05);
		expect(result[2]?.totalCost).toBe(0.02);
	});

	test("filters sessions by date range", async () => {
		const basePath = path.join("/home/test", ".claude", "projects");
		const mockGlob = mock(() =>
			Promise.resolve([
				path.join(basePath, "project1", "session1", "chat.jsonl"),
				path.join(basePath, "project2", "session2", "chat.jsonl"),
			]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(glob as any).mockImplementation(mockGlob);

		const mockReadFile = mock((file: string) => {
			if (file.includes("session1")) {
				return Promise.resolve(
					JSON.stringify({
						timestamp: "2024-01-15T00:00:00Z",
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					}),
				);
			}
			return Promise.resolve(
				JSON.stringify({
					timestamp: "2024-02-01T00:00:00Z",
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				}),
			);
		});
		// biome-ignore lint/suspicious/noExplicitAny: mocking external library
		(readFile as any).mockImplementation(mockReadFile);

		const result = await loadSessionData({
			since: "20240110",
			until: "20240125",
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.lastActivity).toBe("2024-01-15");
	});
});

describe("data-loader cost calculation with real pricing", () => {
	beforeEach(() => {
		// Restore all mocks to ensure clean state
		mock.restore();

		// Explicitly unmock modules that may have been mocked by other tests
		mock.module("node:fs/promises", () => ({ readFile }));
		mock.module("tinyglobby", () => ({ glob }));
		mock.module("node:os", () => ({ homedir }));

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
					"test-project": {
						session1: {
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
					"test-project": {
						session2: {
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
					"test-project": {
						session3: {
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
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
				// No costUSD and no model
			};

			await using fixture = await createFixture({
				projects: {
					"test-project": {
						session4: {
							"usage.jsonl": `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBe(0); // Should be 0 without model or costUSD
		});
	});

	describe("loadSessionData with mixed schemas", () => {
		test("should calculate costs correctly for sessions", async () => {
			// Session 1: old schema
			const oldData = {
				timestamp: "2024-01-18T10:00:00Z",
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
				costUSD: 0.05,
			};

			// Session 2: new schema with model
			const newData = {
				timestamp: "2024-01-19T10:00:00Z",
				message: {
					usage: { input_tokens: 500, output_tokens: 250 },
					model: "claude-3-5-sonnet-20241022",
				},
			};

			await using fixture = await createFixture({
				projects: {
					"project-a": {
						session1: {
							"usage.jsonl": `${JSON.stringify(oldData)}\n`,
						},
						session2: {
							"usage.jsonl": `${JSON.stringify(newData)}\n`,
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
			expect(session2?.inputTokens).toBe(500);
			expect(session2?.outputTokens).toBe(250);
		});

		test("should handle unknown models gracefully", async () => {
			const data = {
				timestamp: "2024-01-20T10:00:00Z",
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: "unknown-model-xyz",
				},
			};

			await using fixture = await createFixture({
				projects: {
					"test-project": {
						session4: {
							"usage.jsonl": `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadSessionData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBe(0); // Should be 0 for unknown model
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
		});
	});

	describe("cached tokens cost calculation", () => {
		test("should correctly calculate costs for all token types with claude-3-5-sonnet-20241022", async () => {
			const data = {
				timestamp: "2024-01-21T10:00:00Z",
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 2000,
						cache_read_input_tokens: 3000,
					},
					model: "claude-3-5-sonnet-20241022",
				},
			};

			await using fixture = await createFixture({
				projects: {
					"test-project": {
						session5: {
							"usage.jsonl": `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(2000);
			expect(results[0]?.cacheReadTokens).toBe(3000);

			// Should have calculated cost (greater than 0)
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});
	});
});
