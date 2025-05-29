import { beforeAll, describe, expect, test } from "bun:test";
import { CostCalculator } from "./cost-calculator";

describe("CostCalculator", () => {
	let calculator: CostCalculator;

	beforeAll(async () => {
		// Use local file for tests to avoid network dependency
		calculator = await CostCalculator.fromFile("./model_prices.json");
	});

	test("should fetch pricing data from URL", async () => {
		const onlineCalculator = await CostCalculator.fromUrl();
		const models = onlineCalculator.listModels();
		expect(models.length).toBeGreaterThan(0);
	});

	test("should calculate cost for a model", () => {
		// Using gpt-4o as an example (assuming it exists in the data)
		const models = calculator.listModels();
		const testModel = models.find((m) => m.includes("gpt-4")) || models[0];

		if (testModel) {
			const cost = calculator.calculateCost(testModel, 1000, 500);

			expect(cost.inputTokens).toBe(1000);
			expect(cost.outputTokens).toBe(500);
			expect(cost.totalCost).toBeGreaterThanOrEqual(0);
			expect(cost.inputCost + cost.outputCost).toBe(cost.totalCost);
		}
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
		if (models.length > 0) {
			const modelInfo = calculator.getModelInfo(models[0]);
			expect(modelInfo).toBeDefined();
			expect(typeof modelInfo?.input_cost_per_token).toBe("number");
			expect(typeof modelInfo?.output_cost_per_token).toBe("number");
		}
	});
});
