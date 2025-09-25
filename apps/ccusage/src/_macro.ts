import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import process from 'node:process';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

function isClaudeModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return modelName.startsWith('claude-');
}

export async function prefetchClaudePricing(): Promise<Record<string, LiteLLMModelPricing>> {
	if (process.env.OFFLINE === 'true') {
		return createPricingDataset();
	}

	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isClaudeModel);
	}
	catch (error) {
		console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
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

function isGLMModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	const lowerModelName = modelName.toLowerCase();
	return GLM_MODEL_PREFIXES.some(prefix =>
		lowerModelName.includes(prefix.toLowerCase()),
	);
}

export async function prefetchGLMPricing(): Promise<Record<string, LiteLLMModelPricing>> {
	if (process.env.OFFLINE === 'true') {
		return createPricingDataset();
	}

	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isGLMModel);
	}
	catch (error) {
		console.warn('Failed to prefetch GLM pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
