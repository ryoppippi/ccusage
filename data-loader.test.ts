import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import {
	type DailyUsage,
	type SessionUsage,
	type UsageData,
	formatDate,
	loadSessionData,
	loadUsageData,
} from "./data-loader.ts";

// Mock the external dependencies
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
