import { beforeAll, describe, expect, test } from "bun:test";
import { CostCalculator } from "./cost-calculator";
import type { DailyUsage, SessionUsage } from "./data-loader";

describe("CostCalculator", () => {
	let calculator: CostCalculator;

	beforeAll(async () => {
		// Use local file for tests to avoid network dependency
		calculator = await CostCalculator.fromUrl();
	});

	test("should fetch pricing data from URL", async () => {
		const onlineCalculator = await CostCalculator.fromUrl();
		const models = onlineCalculator.listModels();
		expect(models.length).toBeGreaterThan(0);
	});

	test("should search models", () => {
		const gptModels = calculator.searchModels("gpt");
		expect(gptModels.length).toBeGreaterThan(0);
		expect(
			gptModels.every((model) => model.toLowerCase().includes("gpt")),
		).toBe(true);
	});

	test("should get model info", () => {
		const models = calculator.listModels();
		const model = models.at(0);
		expect(model).toBeString();
		const modelInfo = calculator.getModelInfo(model as string);
		expect(modelInfo).toBeDefined();
		expect(typeof modelInfo?.input_cost_per_token).toBe("number");
		expect(typeof modelInfo?.output_cost_per_token).toBe("number");
	});
});

describe("CostCalculator - Aggregation utilities", () => {
	test("calculateTotals should aggregate daily usage data", () => {
		const dailyData: DailyUsage[] = [
			{
				date: "2024-01-01",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
				totalCost: 0.01,
			},
			{
				date: "2024-01-02",
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 50,
				cacheReadTokens: 20,
				totalCost: 0.02,
			},
		];

		const totals = CostCalculator.calculateTotals(dailyData);
		expect(totals.inputTokens).toBe(300);
		expect(totals.outputTokens).toBe(150);
		expect(totals.cacheCreationTokens).toBe(75);
		expect(totals.cacheReadTokens).toBe(30);
		expect(totals.totalCost).toBeCloseTo(0.03);
	});

	test("calculateTotals should aggregate session usage data", () => {
		const sessionData: SessionUsage[] = [
			{
				sessionId: "session-1",
				projectPath: "project/path",
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
				totalCost: 0.01,
				lastActivity: "2024-01-01",
			},
			{
				sessionId: "session-2",
				projectPath: "project/path",
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 50,
				cacheReadTokens: 20,
				totalCost: 0.02,
				lastActivity: "2024-01-02",
			},
		];

		const totals = CostCalculator.calculateTotals(sessionData);
		expect(totals.inputTokens).toBe(300);
		expect(totals.outputTokens).toBe(150);
		expect(totals.cacheCreationTokens).toBe(75);
		expect(totals.cacheReadTokens).toBe(30);
		expect(totals.totalCost).toBeCloseTo(0.03);
	});

	test("getTotalTokens should sum all token types", () => {
		const tokens = {
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 25,
			cacheReadTokens: 10,
		};

		const total = CostCalculator.getTotalTokens(tokens);
		expect(total).toBe(185);
	});

	test("getTotalTokens should handle zero values", () => {
		const tokens = {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
		};

		const total = CostCalculator.getTotalTokens(tokens);
		expect(total).toBe(0);
	});

	test("createTotalsObject should create complete totals object", () => {
		const totals = {
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 25,
			cacheReadTokens: 10,
			totalCost: 0.01,
		};

		const totalsObject = CostCalculator.createTotalsObject(totals);
		expect(totalsObject).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 25,
			cacheReadTokens: 10,
			totalTokens: 185,
			totalCost: 0.01,
		});
	});

	test("calculateTotals should handle empty array", () => {
		const totals = CostCalculator.calculateTotals([]);
		expect(totals).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
		});
	});
});
