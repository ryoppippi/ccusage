import type { LiteLLMModelPrices, ModelSpec } from "./types";

interface CostCalculation {
	inputTokens: number;
	outputTokens: number;
	inputCost: number;
	outputCost: number;
	totalCost: number;
}

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
		const data = (await response.json()) as LiteLLMModelPrices;
		return new CostCalculator(data);
	}

	calculateCost(
		modelName: string,
		inputTokens: number,
		outputTokens = 0,
	): CostCalculation {
		const modelSpec = this.modelPrices[modelName];

		if (!modelSpec) {
			throw new Error(`Model "${modelName}" not found in pricing data`);
		}

		const inputCost = inputTokens * modelSpec.input_cost_per_token;
		const outputCost = outputTokens * modelSpec.output_cost_per_token;
		const totalCost = inputCost + outputCost;

		return {
			inputTokens,
			outputTokens,
			inputCost,
			outputCost,
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
