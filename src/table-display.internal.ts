import type { SessionBlock } from './session-blocks.internal.ts';
import pc from 'picocolors';
import { formatCurrency, formatModelsDisplay, formatNumber, ResponsiveTable } from './utils.internal.ts';

/**
 * Model token breakdown data structure
 */
type ModelTokenBreakdown = {
	input: number;
	output: number;
	cacheCreate: number;
	cacheRead: number;
};

/**
 * Model cost breakdown data structure
 */
type ModelCostBreakdown = {
	input: number;
	output: number;
	cacheCreate: number;
	cacheRead: number;
};

/**
 * Calculates token breakdown by model from session block
 */
function calculateTokenBreakdownByModel(block: SessionBlock): Map<string, ModelTokenBreakdown> {
	const modelBreakdown = new Map<string, ModelTokenBreakdown>();

	for (const entry of block.entries) {
		const modelName = entry.model;
		const current = modelBreakdown.get(modelName) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

		modelBreakdown.set(modelName, {
			input: current.input + entry.usage.inputTokens,
			output: current.output + entry.usage.outputTokens,
			cacheCreate: current.cacheCreate + entry.usage.cacheCreationInputTokens,
			cacheRead: current.cacheRead + entry.usage.cacheReadInputTokens,
		});
	}

	return modelBreakdown;
}

/**
 * Calculates cost breakdown by model from session block
 */
function calculateCostBreakdownByModel(block: SessionBlock): Map<string, ModelCostBreakdown> {
	const modelCostBreakdown = new Map<string, ModelCostBreakdown>();

	for (const entry of block.entries) {
		const modelName = entry.model;
		const current = modelCostBreakdown.get(modelName) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

		// Calculate individual cost components
		// We need to estimate the cost breakdown since we only have total costUSD
		const totalTokens = entry.usage.inputTokens + entry.usage.outputTokens + entry.usage.cacheCreationInputTokens + entry.usage.cacheReadInputTokens;
		if (totalTokens > 0 && entry.costUSD != null && entry.costUSD > 0) {
			const costPerToken = entry.costUSD / totalTokens;
			modelCostBreakdown.set(modelName, {
				input: current.input + (entry.usage.inputTokens * costPerToken),
				output: current.output + (entry.usage.outputTokens * costPerToken),
				cacheCreate: current.cacheCreate + (entry.usage.cacheCreationInputTokens * costPerToken),
				cacheRead: current.cacheRead + (entry.usage.cacheReadInputTokens * costPerToken),
			});
		}
	}

	return modelCostBreakdown;
}

/**
 * Creates a responsive tokens table for session block
 */
export function createTokensTable(block: SessionBlock): ResponsiveTable {
	const table = new ResponsiveTable({
		head: ['Tokens', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total'],
		style: { head: ['cyan'] },
		colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
	});

	// Calculate token breakdown by model
	const modelBreakdown = calculateTokenBreakdownByModel(block);

	// Sort models by name for consistent display
	const sortedModels = Array.from(modelBreakdown.entries()).sort(([a], [b]) => a.localeCompare(b));

	// Track totals
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheCreate = 0;
	let totalCacheRead = 0;

	// Add rows for each model
	for (const [modelName, tokens] of sortedModels) {
		if (tokens.input > 0 || tokens.output > 0 || tokens.cacheCreate > 0 || tokens.cacheRead > 0) {
			const total = tokens.input + tokens.output + tokens.cacheCreate + tokens.cacheRead;
			const displayName = formatModelsDisplay([modelName]);

			table.push([
				displayName,
				formatNumber(tokens.input),
				formatNumber(tokens.output),
				formatNumber(tokens.cacheCreate),
				formatNumber(tokens.cacheRead),
				formatNumber(total),
			]);

			totalInput += tokens.input;
			totalOutput += tokens.output;
			totalCacheCreate += tokens.cacheCreate;
			totalCacheRead += tokens.cacheRead;
		}
	}

	// Add total row if there are multiple models
	if (modelBreakdown.size > 1) {
		table.push([
			pc.bold('Total'),
			pc.bold(formatNumber(totalInput)),
			pc.bold(formatNumber(totalOutput)),
			pc.bold(formatNumber(totalCacheCreate)),
			pc.bold(formatNumber(totalCacheRead)),
			pc.bold(formatNumber(totalInput + totalOutput + totalCacheCreate + totalCacheRead)),
		]);
	}

	return table;
}

/**
 * Creates a responsive cost table for session block
 */
export function createCostTable(block: SessionBlock): ResponsiveTable {
	const table = new ResponsiveTable({
		head: ['Cost', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total'],
		style: { head: ['cyan'] },
		colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
	});

	// Calculate cost breakdown by model
	const modelCostBreakdown = calculateCostBreakdownByModel(block);

	// Sort models by name for consistent display
	const sortedModels = Array.from(modelCostBreakdown.entries()).sort(([a], [b]) => a.localeCompare(b));

	// Track totals
	let totalInputCost = 0;
	let totalOutputCost = 0;
	let totalCacheCreateCost = 0;
	let totalCacheReadCost = 0;

	// Add rows for each model
	for (const [modelName, costs] of sortedModels) {
		const totalCost = costs.input + costs.output + costs.cacheCreate + costs.cacheRead;
		if (totalCost > 0) {
			const displayName = formatModelsDisplay([modelName]);

			table.push([
				displayName,
				formatCurrency(costs.input),
				formatCurrency(costs.output),
				formatCurrency(costs.cacheCreate),
				formatCurrency(costs.cacheRead),
				formatCurrency(totalCost),
			]);

			totalInputCost += costs.input;
			totalOutputCost += costs.output;
			totalCacheCreateCost += costs.cacheCreate;
			totalCacheReadCost += costs.cacheRead;
		}
	}

	// Add total row if there are multiple models
	if (modelCostBreakdown.size > 1) {
		table.push([
			pc.bold('Total'),
			pc.bold(formatCurrency(totalInputCost)),
			pc.bold(formatCurrency(totalOutputCost)),
			pc.bold(formatCurrency(totalCacheCreateCost)),
			pc.bold(formatCurrency(totalCacheReadCost)),
			pc.bold(formatCurrency(totalInputCost + totalOutputCost + totalCacheCreateCost + totalCacheReadCost)),
		]);
	}

	return table;
}

/**
 * Displays tokens breakdown table
 */
export function displayTokensTable(block: SessionBlock): string {
	const table = createTokensTable(block);
	return table.toString();
}

/**
 * Displays cost breakdown table
 */
export function displayCostTable(block: SessionBlock): string {
	const table = createCostTable(block);
	return table.toString();
}
