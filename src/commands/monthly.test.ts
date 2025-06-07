import { describe, expect, test } from "bun:test";
import type { DailyUsage } from "../data-loader.ts";
import { aggregateByMonth } from "./monthly.ts";

describe("aggregateByMonth", () => {
	test("aggregates daily data by month correctly", () => {
		const dailyData: DailyUsage[] = [
			{
				date: "2024-01-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			},
			{
				date: "2024-01-15",
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 20,
				cacheReadTokens: 10,
				totalCost: 0.02,
			},
			{
				date: "2024-02-01",
				inputTokens: 150,
				outputTokens: 75,
				cacheCreationTokens: 15,
				cacheReadTokens: 7,
				totalCost: 0.015,
			},
		];

		// Test the actual aggregateByMonth function
		const result = aggregateByMonth(dailyData);

		// Should be sorted by month descending (2024-02 first)
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			month: "2024-02",
			inputTokens: 150,
			outputTokens: 75,
			cacheCreationTokens: 15,
			cacheReadTokens: 7,
			totalCost: 0.015,
		});
		expect(result[1]).toEqual({
			month: "2024-01",
			inputTokens: 300,
			outputTokens: 150,
			cacheCreationTokens: 30,
			cacheReadTokens: 15,
			totalCost: 0.03,
		});
	});

	test("handles empty data", () => {
		const dailyData: DailyUsage[] = [];
		const result = aggregateByMonth(dailyData);

		expect(result).toEqual([]);
	});

	test("handles single month data", () => {
		const dailyData: DailyUsage[] = [
			{
				date: "2024-01-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			},
			{
				date: "2024-01-31",
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 20,
				cacheReadTokens: 10,
				totalCost: 0.02,
			},
		];

		const result = aggregateByMonth(dailyData);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			month: "2024-01",
			inputTokens: 300,
			outputTokens: 150,
			cacheCreationTokens: 30,
			cacheReadTokens: 15,
			totalCost: 0.03,
		});
	});

	test("sorts months in descending order", () => {
		const dailyData: DailyUsage[] = [
			{
				date: "2024-01-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			},
			{
				date: "2024-03-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			},
			{
				date: "2024-02-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			},
			{
				date: "2023-12-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			},
		];

		const result = aggregateByMonth(dailyData);
		const months = result.map((r) => r.month);

		expect(months).toEqual(["2024-03", "2024-02", "2024-01", "2023-12"]);
	});
});
