import type { ModelPricing } from '@better-ccusage/internal/pricing';
import {
	createPricingDataset,
	filterPricingDataset,
	loadLocalPricingDataset,
} from '@better-ccusage/internal/pricing-fetch-utils';

function isClaudeModel(modelName: string, _pricing: ModelPricing): boolean {
	return modelName.startsWith('claude-');
}

export async function prefetchClaudePricing(): Promise<Record<string, ModelPricing>> {
	try {
		// Always use local pricing data
		const dataset = loadLocalPricingDataset();
		return filterPricingDataset(dataset, isClaudeModel);
	}
	catch (error) {
		console.warn('Failed to load local Claude pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}

const GLM_MODEL_PREFIXES = [
	'glm-4',
	'glm-4.5',
	'glm-4-5',
	'deepinfra/zai-org/GLM',
	'vercel_ai_gateway/zai/glm',
	'deepinfra/glm',
	'vercel_ai_gateway/glm',
	'glm-4.5-air',
	'glm-4-air',
];

function isGLMModel(modelName: string, _pricing: ModelPricing): boolean {
	const lowerModelName = modelName.toLowerCase();
	return GLM_MODEL_PREFIXES.some(prefix =>
		lowerModelName.includes(prefix.toLowerCase()),
	);
}

export async function prefetchGLMPricing(): Promise<Record<string, ModelPricing>> {
	try {
		// Always use local pricing data
		const dataset = loadLocalPricingDataset();
		return filterPricingDataset(dataset, isGLMModel);
	}
	catch (error) {
		console.warn('Failed to load local GLM pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
