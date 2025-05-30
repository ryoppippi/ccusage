import { beforeAll, describe, expect, test } from "bun:test";
import { CostCalculator } from "./cost-calculator";

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
