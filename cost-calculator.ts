import * as v from "valibot";
import type { DailyUsage, SessionUsage } from "./data-loader";
import type { LiteLLMModelPrices, ModelSpec } from "./types";
import { LiteLLMModelPricesSchema } from "./types";

export interface TokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
}

export interface TokenData {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
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
		const json = await response.json();
		const result = v.parse(LiteLLMModelPricesSchema, json);
		return new CostCalculator(result);
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

	// Static utility methods for aggregating usage data
	static calculateTotals(data: Array<DailyUsage | SessionUsage>): TokenTotals {
		return data.reduce(
			(acc, item) => ({
				inputTokens: acc.inputTokens + item.inputTokens,
				outputTokens: acc.outputTokens + item.outputTokens,
				cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
				cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
				totalCost: acc.totalCost + item.totalCost,
			}),
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
			},
		);
	}

	static getTotalTokens(tokens: TokenData): number {
		return (
			tokens.inputTokens +
			tokens.outputTokens +
			tokens.cacheCreationTokens +
			tokens.cacheReadTokens
		);
	}

	static createTotalsObject(totals: TokenTotals) {
		return {
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			cacheCreationTokens: totals.cacheCreationTokens,
			cacheReadTokens: totals.cacheReadTokens,
			totalTokens: CostCalculator.getTotalTokens(totals),
			totalCost: totals.totalCost,
		};
	}
}
