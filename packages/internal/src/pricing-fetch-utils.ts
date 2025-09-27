import type { ModelPricing } from './pricing.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cwd } from 'node:process';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
	modelPricingSchema,
	PRICING_DATA_URL,
} from './pricing.ts';

export type PricingDataset = Record<string, ModelPricing>;

export function createPricingDataset(): PricingDataset {
	return Object.create(null) as PricingDataset;
}

export function loadLocalPricingDataset(): PricingDataset {
	try {
		// Load the local pricing JSON file from multiple possible locations
		// Try current working directory first (for development)
		// Then try relative to this file (for published package)
		// Get the directory of the current module (cross-platform)
		const currentModuleDir = dirname(fileURLToPath(import.meta.url));

		const possiblePaths = [
			// Published package: alongside the bundled file in dist/
			join(currentModuleDir, 'model_prices_and_context_window.json'),
			// Development: in the app root directory
			join(cwd(), 'model_prices_and_context_window.json'),
		];

		let rawData: string | undefined;

		for (const path of possiblePaths) {
			try {
				rawData = readFileSync(path, 'utf8');
				break;
			}
			catch {
				// Continue to next path
			}
		}

		if (rawData === undefined || rawData === null || rawData.trim() === '') {
			throw new Error(`Could not find model_prices_and_context_window.json in any of these locations: ${possiblePaths.join(', ')}`);
		}
		const jsonDataset = JSON.parse(rawData) as Record<string, unknown>;

		const dataset = createPricingDataset();

		for (const [modelName, modelData] of Object.entries(jsonDataset)) {
			if (modelData === null || modelData === undefined || typeof modelData !== 'object') {
				continue;
			}

			const parsed = v.safeParse(modelPricingSchema, modelData);
			if (!parsed.success) {
				continue;
			}

			dataset[modelName] = parsed.output;
		}

		return dataset;
	}
	catch (error) {
		console.warn('Failed to load local pricing data, returning empty dataset:', error);
		return createPricingDataset();
	}
}

export async function fetchPricingDataset(): Promise<PricingDataset> {
	const response = await fetch(PRICING_DATA_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch pricing data: ${response.status} ${response.statusText}`);
	}

	const rawDataset = await response.json() as Record<string, unknown>;
	const dataset = createPricingDataset();

	for (const [modelName, modelData] of Object.entries(rawDataset)) {
		if (modelData === null || modelData === undefined || typeof modelData !== 'object') {
			continue;
		}

		const parsed = v.safeParse(modelPricingSchema, modelData);
		if (!parsed.success) {
			continue;
		}

		dataset[modelName] = parsed.output;
	}

	return dataset;
}

export function filterPricingDataset(
	dataset: PricingDataset,
	predicate: (modelName: string, pricing: ModelPricing) => boolean,
): PricingDataset {
	const filtered = createPricingDataset();
	for (const [modelName, pricing] of Object.entries(dataset)) {
		if (predicate(modelName, pricing)) {
			filtered[modelName] = pricing;
		}
	}
	return filtered;
}
