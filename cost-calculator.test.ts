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

	test("should calculate cost for a opus-4 model", () => {
		// Using opus-4 model as an example
		// https://www.anthropic.com/pricing
		const models = calculator.listModels();
		const testModel = models.find((m) => m.includes("claude-opus-4-20250514"));

		expect(testModel).toBeDefined();

		const cost = calculator.calculateCost(
			testModel as string,
			/* millions of tokens */ 1_000_000,
			/* millions of output tokens */ 1_000_000,
		);

		expect(cost.inputTokens).toBe(1_000_000);
		expect(cost.outputTokens).toBe(1_000_000);
		expect(cost.inputCost).toEqual(15);
		expect(cost.outputCost).toEqual(75);
	});

	test("should calculate cost with cache tokens for opus-4 model", () => {
		const models = calculator.listModels();
		const testModel = models.find((m) => m.includes("claude-opus-4-20250514"));

		expect(testModel).toBeDefined();

		const cost = calculator.calculateCost(
			testModel as string,
			/* input tokens */ 1_000_000,
			/* output tokens */ 1_000_000,
			/* cache creation tokens */ 1_000_000,
			/* cache read tokens */ 1_000_000,
		);

		expect(cost.inputTokens).toBe(1_000_000);
		expect(cost.outputTokens).toBe(1_000_000);
		expect(cost.cacheCreationTokens).toBe(1_000_000);
		expect(cost.cacheReadTokens).toBe(1_000_000);
		expect(cost.inputCost).toEqual(15);
		expect(cost.outputCost).toEqual(75);
		expect(cost.cacheCreationCost).toEqual(18.75);
		expect(cost.cacheReadCost).toEqual(1.5);
		expect(cost.totalCost).toEqual(15 + 75 + 18.75 + 1.5);
	});

	test("should calculate cost for a sonnet-4 model", () => {
		// Using sonnet-4 model as an example
		// https://www.anthropic.com/pricing
		const models = calculator.listModels();
		const testModel = models.find((m) =>
			m.includes("claude-sonnet-4-20250514"),
		);

		expect(testModel).toBeDefined();

		const cost = calculator.calculateCost(
			testModel as string,
			/* millions of tokens */ 1_000_000,
			/* millions of output tokens */ 1_000_000,
		);

		expect(cost.inputTokens).toBe(1_000_000);
		expect(cost.outputTokens).toBe(1_000_000);
		expect(cost.inputCost).toEqual(3);
		expect(cost.outputCost).toEqual(15);
	});

	test("should calculate cost with cache tokens for sonnet-4 model", () => {
		const models = calculator.listModels();
		const testModel = models.find((m) =>
			m.includes("claude-sonnet-4-20250514"),
		);

		expect(testModel).toBeDefined();

		const cost = calculator.calculateCost(
			testModel as string,
			/* input tokens */ 1_000_000,
			/* output tokens */ 1_000_000,
			/* cache creation tokens */ 1_000_000,
			/* cache read tokens */ 1_000_000,
		);

		expect(cost.inputTokens).toBe(1_000_000);
		expect(cost.outputTokens).toBe(1_000_000);
		expect(cost.cacheCreationTokens).toBe(1_000_000);
		expect(cost.cacheReadTokens).toBe(1_000_000);
		expect(cost.inputCost).toEqual(3);
		expect(cost.outputCost).toEqual(15);
		expect(cost.cacheCreationCost).toEqual(3.75);
		expect(cost.cacheReadCost).toEqual(0.3);
		expect(cost.totalCost).toEqual(3 + 15 + 3.75 + 0.3);
	});

	test("should throw error for unknown model", () => {
		expect(() => {
			calculator.calculateCost("unknown-model", 1000);
		}).toThrow('Model "unknown-model" not found in pricing data');
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
