/**
 * Prefetch claude data for the current user.
 */

import type { ModelPricing } from './_types.ts';
import { LITELLM_PRICING_URL } from './_consts.ts';
import { modelPricingSchema } from './_types.ts';

/**
 * Prefetches the pricing data for Claude models from the LiteLLM API.
 * This function fetches the pricing data and filters out models that start with 'claude-'.
 * It returns a record of model names to their pricing information.
 *
 * @returns A promise that resolves to a record of model names and their pricing information.
 * @throws Will throw an error if the fetch operation fails.
 */
export async function prefetchClaudePricing(): Promise<Record<string, ModelPricing>> {
	// Check for proxy configuration and create fetch options
	const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || 
	                 process.env.http_proxy || process.env.HTTP_PROXY;
	
	const fetchOptions: RequestInit = {};
	if (proxyUrl) {
		// For Node.js with undici, we need to use ProxyAgent
		const { ProxyAgent } = await import('undici');
		(fetchOptions as any).dispatcher = new ProxyAgent(proxyUrl);
	}
	
	const response = await fetch(LITELLM_PRICING_URL, fetchOptions);
	if (!response.ok) {
		throw new Error(`Failed to fetch pricing data: ${response.statusText}`);
	}

	const data = await response.json() as Record<string, unknown>;

	const prefetchClaudeData: Record<string, ModelPricing> = {};

	// Cache all models that start with 'claude-'
	for (const [modelName, modelData] of Object.entries(data)) {
		if (modelName.startsWith('claude-') && modelData != null && typeof modelData === 'object') {
			const parsed = modelPricingSchema.safeParse(modelData);
			if (parsed.success) {
				prefetchClaudeData[modelName] = parsed.data;
			}
		}
	}

	return prefetchClaudeData;
}
