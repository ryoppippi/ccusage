import * as v from "valibot";
import type { LiteLLMModelPrices, ModelSpec } from "./types";
import { LiteLLMModelPricesSchema } from "./types";

const CostCalculationSchema = v.object({
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	inputCost: v.number(),
	outputCost: v.number(),
	cacheCreationCost: v.number(),
	cacheReadCost: v.number(),
	totalCost: v.number(),
});

type CostCalculation = v.InferOutput<typeof CostCalculationSchema>;

export class CostCalculator {
	private modelPrices: LiteLLMModelPrices;

	constructor(modelPrices: LiteLLMModelPrices) {
		this.modelPrices = modelPrices;
	}

	static async fromUrl(
		url = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
	): Promise<CostCalculator> {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch pricing data: ${response.statusText}`);
		}
		const json = await response.json();
		const result = v.parse(LiteLLMModelPricesSchema, json);
		return new CostCalculator(result);
	}

	calculateCost(
		modelName: string,
		inputTokens: number,
		outputTokens = 0,
		cacheCreationTokens = 0,
		cacheReadTokens = 0,
	): CostCalculation {
		const modelSpec = this.modelPrices[modelName];

		if (!modelSpec) {
			throw new Error(`Model "${modelName}" not found in pricing data`);
		}

		if (!modelSpec.input_cost_per_token || !modelSpec.output_cost_per_token) {
			throw new Error(`Model "${modelName}" missing cost data`);
		}

		const inputCost = inputTokens * modelSpec.input_cost_per_token;
		const outputCost = outputTokens * modelSpec.output_cost_per_token;
		const cacheCreationCost =
			cacheCreationTokens *
			(modelSpec.cache_creation_input_token_cost ||
				modelSpec.input_cost_per_token);
		const cacheReadCost =
			cacheReadTokens * (modelSpec.cache_read_input_token_cost || 0);
		const totalCost =
			inputCost + outputCost + cacheCreationCost + cacheReadCost;

		return {
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
			inputCost,
			outputCost,
			cacheCreationCost,
			cacheReadCost,
			totalCost,
		};
	}

	getModelInfo(modelName: string): ModelSpec | undefined {
		return this.modelPrices[modelName];
	}

	listModels(): string[] {
		return Object.keys(this.modelPrices).filter((key) => key !== "sample_spec");
	}

	searchModels(query: string): string[] {
		return this.listModels().filter((model) =>
			model.toLowerCase().includes(query.toLowerCase()),
		);
	}
}
