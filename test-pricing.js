#!/usr/bin/env node

import { PricingFetcher } from './apps/better-ccusage/src/_pricing-fetcher.ts';
import { Result } from '@praha/byethrow';

// Données de test fournies
const testData = [
	{
		date: '2025-09-22',
		model: 'sonnet-4',
		inputTokens: 5015,
		outputTokens: 567475,
		cacheWriteTokens: 6242843,
		cacheReadTokens: 6815630,
	},
	{
		date: '2025-09-24',
		model: 'glm-4.5',
		inputTokens: 29339583,
		outputTokens: 2647676,
		cacheWriteTokens: 0,
		cacheReadTokens: 983467084,
	},
];

async function testPricingCalculation() {
	console.log('Test de calcul des prix pour les modèles:\n');

	const fetcher = new PricingFetcher(true);
	const pricingResult = await fetcher.fetchModelPricing();

	if (Result.isFailure(pricingResult)) {
		console.error('Erreur lors du chargement des prix:', pricingResult.error);
		return;
	}

	const pricing = pricingResult.value;

	for (const data of testData) {
		console.log(`Date: ${data.date}`);
		console.log(`Modèle: ${data.model}`);
		console.log(`Input tokens: ${data.inputTokens.toLocaleString()}`);
		console.log(`Output tokens: ${data.outputTokens.toLocaleString()}`);
		console.log(`Cache write tokens: ${data.cacheWriteTokens.toLocaleString()}`);
		console.log(`Cache read tokens: ${data.cacheReadTokens.toLocaleString()}`);

		// Chercher les informations de prix pour ce modèle
		const modelKey = Object.keys(pricing).find(key =>
			key.toLowerCase().includes(data.model.toLowerCase()) ||
			data.model.toLowerCase().includes(key.toLowerCase())
		);

		if (modelKey && pricing[modelKey]) {
			const modelPricing = pricing[modelKey];
			console.log('\nInformations de prix trouvées:');
			console.log(`Modèle exact: ${modelKey}`);
			console.log(`Input price per token: $${modelPricing.input_cost_per_token}`);
			console.log(`Output price per token: $${modelPricing.output_cost_per_token}`);

			if (modelPricing.cache_creation_input_token_cost) {
				console.log(`Cache write price per token: $${modelPricing.cache_creation_input_token_cost}`);
			}
			if (modelPricing.cache_read_input_token_cost) {
				console.log(`Cache read price per token: $${modelPricing.cache_read_input_token_cost}`);
			}

			// Calcul des coûts
			const inputCost = data.inputTokens * modelPricing.input_cost_per_token;
			const outputCost = data.outputTokens * modelPricing.output_cost_per_token;
			const cacheWriteCost = data.cacheWriteTokens * (modelPricing.cache_creation_input_token_cost || 0);
			const cacheReadCost = data.cacheReadTokens * (modelPricing.cache_read_input_token_cost || 0);
			const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

			console.log('\nCalcul des coûts:');
			console.log(`Coût input: $${inputCost.toFixed(6)}`);
			console.log(`Coût output: $${outputCost.toFixed(6)}`);
			console.log(`Coût cache write: $${cacheWriteCost.toFixed(6)}`);
			console.log(`Coût cache read: $${cacheReadCost.toFixed(6)}`);
			console.log(`Coût total: $${totalCost.toFixed(6)} (${totalCost.toFixed(2)})`);
		} else {
			console.log(`\n⚠️  Aucune information de prix trouvée pour le modèle: ${data.model}`);
			console.log('Modèles disponibles:', Object.keys(pricing).slice(0, 10));
		}

		console.log('\n' + '='.repeat(80) + '\n');
	}
}

testPricingCalculation().catch(console.error);