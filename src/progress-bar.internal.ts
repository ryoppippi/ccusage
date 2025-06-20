import type { ModelType } from './types.internal.ts';
import pc from 'picocolors';
import { log } from './logger.ts';

/**
 * Progress bar width constant
 */
export const PROGRESS_BAR_WIDTH = 40;

/**
 * Progress bar character constant
 */
const BAR_CHAR = '■';

/**
 * Gets the model type from a model name
 */
export function getModelType(model: string): ModelType | null {
	if (model.includes('opus')) {
		return 'opus';
	}
	if (model.includes('sonnet')) {
		return 'sonnet';
	}
	if (model.includes('haiku')) {
		return 'haiku';
	}
	return null;
}

/**
 * Creates a progress bar string with the given parameters
 * @param current - Current value
 * @param max - Maximum value
 * @param style - Style configuration for colors
 * @param style.complete - Function to style completed portion
 * @param style.incomplete - Function to style incomplete portion
 * @param style.warning - Optional function to style warning state
 * @param style.warningThreshold - Optional threshold for warning state (0-1)
 * @returns Formatted progress bar string
 */
export function createProgressBar(
	current: number,
	max: number,
	style: {
		complete: (str: string) => string;
		incomplete: (str: string) => string;
		warning?: (str: string) => string;
		warningThreshold?: number;
	} = { complete: pc.green, incomplete: pc.red },
): string {
	const percentage = Math.min(current / max, 1);
	const filledWidth = Math.floor(percentage * PROGRESS_BAR_WIDTH);
	const emptyWidth = PROGRESS_BAR_WIDTH - filledWidth;

	const isWarning = style.warningThreshold != null && percentage >= style.warningThreshold;
	const completeColor = isWarning && style.warning != null ? style.warning : style.complete;

	const filled = BAR_CHAR.repeat(filledWidth);
	const empty = BAR_CHAR.repeat(emptyWidth);

	return `[${completeColor(filled)}${style.incomplete(empty)}]`;
}

/**
 * Creates and displays the combined progress bar for models grouped by type
 */
export function displayCostProgressBar(
	modelCosts: Map<string, number>,
	maxCost: number,
	projection: { totalCost: number } | null,
): void {
	// Group costs by model type
	let opusCost = 0;
	let sonnetCost = 0;
	let haikuCost = 0;

	for (const [modelName, cost] of modelCosts.entries()) {
		const modelType = getModelType(modelName);
		if (modelType != null) {
			switch (modelType) {
				case 'opus':
					opusCost += cost;
					break;
				case 'sonnet':
					sonnetCost += cost;
					break;
				case 'haiku':
					haikuCost += cost;
					break;
			}
		}
	}
	const totalUsedCost = opusCost + sonnetCost + haikuCost;

	// Calculate percentages, capping at 1.0 for display purposes
	const totalPercentage = Math.min(totalUsedCost / maxCost, 1.0);
	const opusPercentage = totalUsedCost > 0 ? opusCost / totalUsedCost : 0;
	const sonnetPercentage = totalUsedCost > 0 ? sonnetCost / totalUsedCost : 0;
	const haikuPercentage = totalUsedCost > 0 ? haikuCost / totalUsedCost : 0;

	// Calculate widths based on the actual usage up to 100%
	const usedWidth = Math.round(totalPercentage * PROGRESS_BAR_WIDTH);

	// Distribute the used width proportionally among models
	let opusWidth = 0;
	let sonnetWidth = 0;
	let haikuWidth = 0;

	if (usedWidth > 0 && totalUsedCost > 0) {
		// Calculate proportional widths
		opusWidth = opusCost > 0 ? Math.max(1, Math.round(opusPercentage * usedWidth)) : 0;
		sonnetWidth = sonnetCost > 0 ? Math.max(1, Math.round(sonnetPercentage * usedWidth)) : 0;
		haikuWidth = haikuCost > 0 ? Math.max(1, Math.round(haikuPercentage * usedWidth)) : 0;

		// Adjust if total exceeds usedWidth due to rounding
		const totalModelWidth = opusWidth + sonnetWidth + haikuWidth;
		if (totalModelWidth > usedWidth) {
			// Reduce the largest width
			if (opusWidth >= sonnetWidth && opusWidth >= haikuWidth && opusWidth > 1) {
				opusWidth -= (totalModelWidth - usedWidth);
			}
			else if (sonnetWidth >= haikuWidth && sonnetWidth > 1) {
				sonnetWidth -= (totalModelWidth - usedWidth);
			}
			else if (haikuWidth > 1) {
				haikuWidth -= (totalModelWidth - usedWidth);
			}
		}

		// Ensure we don't have negative widths
		opusWidth = Math.max(0, opusWidth);
		sonnetWidth = Math.max(0, sonnetWidth);
		haikuWidth = Math.max(0, haikuWidth);
	}

	const totalModelWidth = opusWidth + sonnetWidth + haikuWidth;
	const emptyWidth = Math.max(0, PROGRESS_BAR_WIDTH - totalModelWidth);

	// Build the progress bar with colors
	const opusBar = pc.blue(BAR_CHAR.repeat(opusWidth));
	const sonnetBar = pc.cyan(BAR_CHAR.repeat(sonnetWidth));
	const haikuBar = pc.magenta(BAR_CHAR.repeat(haikuWidth));
	const emptyBar = pc.gray(BAR_CHAR.repeat(emptyWidth));

	const combinedProgress = `[${opusBar}${sonnetBar}${haikuBar}${emptyBar}]`;

	// Calculate percentages and projections based on cost
	const totalPercentageText = ((totalUsedCost / maxCost) * 100).toFixed(1);

	let projectedPercentageText = '';
	if (projection != null) {
		const projectedPercentage = (projection.totalCost / maxCost) * 100;
		const projectedPercentageStr = projectedPercentage.toFixed(1);
		if (projectedPercentage > 100) {
			projectedPercentageText = ` (Est. ${pc.red(`${projectedPercentageStr}%`)})`;
		}
		else {
			projectedPercentageText = ` (Est. ${projectedPercentageStr}%)`;
		}
	}

	// Display the combined progress bar
	log(`Cost Usage:     ${combinedProgress} ${totalPercentageText}%${projectedPercentageText}`);

	// Show legend - only display models that have been used (based on cost)
	const legendItems = [];
	if (opusCost > 0) {
		const opusPercentageDisplay = ((opusCost / maxCost) * 100).toFixed(1);
		legendItems.push(`${pc.blue(BAR_CHAR)} opus ${opusPercentageDisplay}%`);
	}
	if (sonnetCost > 0) {
		const sonnetPercentageDisplay = ((sonnetCost / maxCost) * 100).toFixed(1);
		legendItems.push(`${pc.cyan(BAR_CHAR)} sonnet ${sonnetPercentageDisplay}%`);
	}
	if (haikuCost > 0) {
		const haikuPercentageDisplay = ((haikuCost / maxCost) * 100).toFixed(1);
		legendItems.push(`${pc.magenta(BAR_CHAR)} haiku ${haikuPercentageDisplay}%`);
	}
	legendItems.push(`${pc.gray(BAR_CHAR)} Unused`);
	log(`   ${legendItems.join('  ')}`);
	log('');
}

/**
 * Calculates model breakdown data from block entries using actual model names
 */
export function calculateModelBreakdown(entries: { model: string; usage: { inputTokens: number; outputTokens: number }; costUSD: number | null }[]): {
	modelTokens: Map<string, number>;
	modelCosts: Map<string, number>;
} {
	const modelTokens = new Map<string, number>();
	const modelCosts = new Map<string, number>();

	for (const entry of entries) {
		const modelName = entry.model;

		const currentTokens = modelTokens.get(modelName) ?? 0;
		const entryTokens = entry.usage.inputTokens + entry.usage.outputTokens;
		modelTokens.set(modelName, currentTokens + entryTokens);

		const currentCost = modelCosts.get(modelName) ?? 0;
		const entryCost = entry.costUSD ?? 0;
		modelCosts.set(modelName, currentCost + entryCost);
	}

	return { modelTokens, modelCosts };
}
