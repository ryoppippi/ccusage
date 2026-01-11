import pc from 'picocolors';

/**
 * Semantic color token system for terminal output.
 * Provides consistent, meaningful color usage across all visualizations.
 */

// Color function type from picocolors
type ColorFn = (text: string) => string;

/**
 * Semantic color tokens organized by purpose.
 * Use these instead of raw picocolors for consistent theming.
 */
export const colors = {
	/** Text hierarchy colors */
	text: {
		/** Main content - default text */
		primary: (s: string) => s,
		/** Muted/supporting text */
		secondary: pc.gray,
		/** Highlighted values, headers */
		accent: pc.cyan,
		/** Strong emphasis */
		emphasis: pc.bold,
	},

	/** Semantic state colors */
	semantic: {
		/** Good/success/below threshold */
		success: pc.green,
		/** Neutral information */
		info: pc.blue,
		/** Elevated/attention needed */
		warning: pc.yellow,
		/** Critical/above threshold */
		error: pc.red,
	},

	/** UI element colors */
	ui: {
		/** Table borders, dividers */
		border: pc.gray,
		/** Totals row highlighting */
		totals: pc.yellow,
		/** Sub-rows, breakdowns */
		breakdown: pc.gray,
	},
} as const;

/**
 * Model color palette for legend display.
 * Cycles through these colors when displaying multiple models.
 */
export const MODEL_COLORS: ColorFn[] = [pc.magenta, pc.blue, pc.green, pc.cyan, pc.yellow, pc.red];

/**
 * Get a color for a model based on its index in the list.
 * Colors cycle if there are more models than colors.
 */
export function getModelColor(index: number): ColorFn {
	return MODEL_COLORS[index % MODEL_COLORS.length] ?? pc.white;
}

/**
 * Threshold configuration for value-based coloring.
 */
export type ValueThresholds = {
	/** Value above which color is 'error' (red) */
	critical: number;
	/** Value above which color is 'warning' (yellow) */
	high: number;
	/** Value below which color is 'success' (green) */
	low: number;
};

/**
 * Get semantic color based on value relative to thresholds.
 * Useful for coloring costs, percentages, or other numeric values.
 */
export function getValueColor(value: number, thresholds: ValueThresholds): ColorFn {
	if (value >= thresholds.critical) {
		return colors.semantic.error;
	}
	if (value >= thresholds.high) {
		return colors.semantic.warning;
	}
	if (value <= thresholds.low) {
		return colors.semantic.success;
	}
	return colors.text.primary;
}

/**
 * Threshold configuration for percentage deviation from average.
 */
export type DeviationThresholds = {
	/** Percentage above average for critical (e.g., 100 = 100% above) */
	significantlyAbove: number;
	/** Percentage above average for warning (e.g., 25 = 25% above) */
	above: number;
	/** Percentage below average for success (e.g., 25 = 25% below) */
	below: number;
	/** Percentage below average for significant (e.g., 100 = 100% below) */
	significantlyBelow: number;
};

/** Default thresholds for cost deviation from average */
export const DEFAULT_DEVIATION_THRESHOLDS: DeviationThresholds = {
	significantlyAbove: 100,
	above: 25,
	below: 25,
	significantlyBelow: 100,
};

/**
 * Trend indicator characters and their meanings.
 */
export const TREND_INDICATORS = {
	significantlyAbove: {
		char: String.fromCodePoint(0x25B2) + String.fromCodePoint(0x25B2),
		description: '>100% above average',
	},
	above: { char: String.fromCodePoint(0x25B2), description: '25-100% above average' },
	neutral: { char: String.fromCodePoint(0x2500), description: 'within 25% of average' },
	below: { char: String.fromCodePoint(0x25BC), description: '25-100% below average' },
	significantlyBelow: {
		char: String.fromCodePoint(0x25BC) + String.fromCodePoint(0x25BC),
		description: '>100% below average',
	},
} as const;

/**
 * Get trend indicator and color based on percentage deviation from average.
 * Positive deviation = above average, negative = below.
 *
 * @param percentDeviation - Percentage deviation from average (e.g., 50 = 50% above, -30 = 30% below)
 * @param thresholds - Optional custom thresholds
 * @returns Object with indicator string and color function
 */
export function getTrendIndicator(
	percentDeviation: number,
	thresholds: DeviationThresholds = DEFAULT_DEVIATION_THRESHOLDS,
): { indicator: string; color: ColorFn; description: string } {
	if (percentDeviation >= thresholds.significantlyAbove) {
		return {
			indicator: `${TREND_INDICATORS.significantlyAbove.char} +${Math.round(percentDeviation)}%`,
			color: colors.semantic.error,
			description: TREND_INDICATORS.significantlyAbove.description,
		};
	}
	if (percentDeviation >= thresholds.above) {
		return {
			indicator: `${TREND_INDICATORS.above.char}  +${Math.round(percentDeviation)}%`,
			color: colors.semantic.warning,
			description: TREND_INDICATORS.above.description,
		};
	}
	if (percentDeviation <= -thresholds.significantlyBelow) {
		return {
			indicator: `${TREND_INDICATORS.significantlyBelow.char} ${Math.round(percentDeviation)}%`,
			color: colors.semantic.success,
			description: TREND_INDICATORS.significantlyBelow.description,
		};
	}
	if (percentDeviation <= -thresholds.below) {
		return {
			indicator: `${TREND_INDICATORS.below.char}  ${Math.round(percentDeviation)}%`,
			color: colors.semantic.success,
			description: TREND_INDICATORS.below.description,
		};
	}
	// Near average
	const sign = percentDeviation >= 0 ? '+' : '';
	return {
		indicator: `${TREND_INDICATORS.neutral.char}  ${sign}${Math.round(percentDeviation)}%`,
		color: colors.text.secondary,
		description: TREND_INDICATORS.neutral.description,
	};
}

/**
 * Unicode bullet character for model legend.
 */
export const LEGEND_BULLET = String.fromCodePoint(0x25CF); // BLACK CIRCLE

/**
 * Create a colored model identifier for compact display.
 *
 * @param modelName - Full model name (e.g., 'opus-4-5')
 * @param colorIndex - Index into MODEL_COLORS palette
 * @returns Formatted string like "●O" with colored bullet
 */
export function createModelIdentifier(modelName: string, colorIndex: number): string {
	const color = getModelColor(colorIndex);
	// extract model family from names like "claude-sonnet-4-20250514" -> "S"
	// or "opus-4-5" -> "O", etc.
	const nameLower = modelName.toLowerCase();
	let letter = 'M'; // default for unknown models
	if (nameLower.includes('opus')) {
		letter = 'O';
	} else if (nameLower.includes('sonnet')) {
		letter = 'S';
	} else if (nameLower.includes('haiku')) {
		letter = 'H';
	} else if (nameLower.includes('gpt')) {
		letter = 'G';
	} else {
		// use first non-claude letter
		const parts = nameLower.split('-').filter((p) => p !== 'claude');
		letter = (parts[0]?.charAt(0) ?? 'M').toUpperCase();
	}
	return `${color(LEGEND_BULLET)}${letter}`;
}

/**
 * Shorten model name by removing the trailing date suffix.
 * e.g., "claude-opus-4-5-20251101" -> "claude-opus-4-5"
 *
 * @param modelName - Full model name with date suffix
 * @returns Shortened model name without date
 */
export function shortenModelName(modelName: string): string {
	// match pattern like -YYYYMMDD at the end
	return modelName.replace(/-\d{8}$/, '');
}

/**
 * Create a legend entry for a model.
 *
 * @param modelName - Full model name (e.g., 'opus-4-5')
 * @param colorIndex - Index into MODEL_COLORS palette
 * @returns Formatted string like "●O opus-4-5"
 */
export function createModelLegendEntry(modelName: string, colorIndex: number): string {
	const color = getModelColor(colorIndex);
	// extract model family from names like "claude-sonnet-4-20250514" -> "S"
	const nameLower = modelName.toLowerCase();
	let letter = 'M';
	if (nameLower.includes('opus')) {
		letter = 'O';
	} else if (nameLower.includes('sonnet')) {
		letter = 'S';
	} else if (nameLower.includes('haiku')) {
		letter = 'H';
	} else if (nameLower.includes('gpt')) {
		letter = 'G';
	} else {
		const parts = nameLower.split('-').filter((p) => p !== 'claude');
		letter = (parts[0]?.charAt(0) ?? 'M').toUpperCase();
	}
	// use shortened model name without date suffix
	return `${color(LEGEND_BULLET)}${letter} ${shortenModelName(modelName)}`;
}

// in-source tests
if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('colors', () => {
		it('has semantic color tokens', () => {
			expect(colors.text.primary('test')).toBe('test');
			expect(typeof colors.semantic.success).toBe('function');
			expect(typeof colors.ui.totals).toBe('function');
		});
	});

	describe('getModelColor', () => {
		it('returns colors from palette', () => {
			expect(getModelColor(0)).toBe(pc.magenta);
			expect(getModelColor(1)).toBe(pc.blue);
			expect(getModelColor(2)).toBe(pc.green);
		});

		it('cycles colors for indices beyond palette size', () => {
			expect(getModelColor(6)).toBe(pc.magenta);
			expect(getModelColor(7)).toBe(pc.blue);
		});
	});

	describe('getValueColor', () => {
		const thresholds: ValueThresholds = {
			critical: 100,
			high: 50,
			low: 10,
		};

		it('returns error color for critical values', () => {
			expect(getValueColor(100, thresholds)).toBe(colors.semantic.error);
			expect(getValueColor(150, thresholds)).toBe(colors.semantic.error);
		});

		it('returns warning color for high values', () => {
			expect(getValueColor(50, thresholds)).toBe(colors.semantic.warning);
			expect(getValueColor(75, thresholds)).toBe(colors.semantic.warning);
		});

		it('returns success color for low values', () => {
			expect(getValueColor(10, thresholds)).toBe(colors.semantic.success);
			expect(getValueColor(5, thresholds)).toBe(colors.semantic.success);
		});

		it('returns primary color for middle values', () => {
			expect(getValueColor(30, thresholds)).toBe(colors.text.primary);
		});
	});

	describe('getTrendIndicator', () => {
		it('returns significantly above for large positive deviation', () => {
			const result = getTrendIndicator(150);
			expect(result.indicator).toContain('+150%');
			expect(result.color).toBe(colors.semantic.error);
		});

		it('returns above for moderate positive deviation', () => {
			const result = getTrendIndicator(50);
			expect(result.indicator).toContain('+50%');
			expect(result.color).toBe(colors.semantic.warning);
		});

		it('returns neutral for small deviation', () => {
			const result = getTrendIndicator(10);
			expect(result.indicator).toContain('+10%');
			expect(result.color).toBe(colors.text.secondary);
		});

		it('returns below for moderate negative deviation', () => {
			const result = getTrendIndicator(-50);
			expect(result.indicator).toContain('-50%');
			expect(result.color).toBe(colors.semantic.success);
		});

		it('returns significantly below for large negative deviation', () => {
			const result = getTrendIndicator(-150);
			expect(result.indicator).toContain('-150%');
			expect(result.color).toBe(colors.semantic.success);
		});
	});

	describe('createModelIdentifier', () => {
		it('creates colored bullet with first letter', () => {
			const result = createModelIdentifier('opus-4-5', 0);
			// result contains ANSI codes, so just check it ends with 'O'
			expect(result).toContain('O');
			expect(result).toContain(LEGEND_BULLET);
		});

		it('extracts O for opus models', () => {
			expect(createModelIdentifier('claude-opus-4-20250514', 0)).toContain('O');
			expect(createModelIdentifier('opus-4-5', 0)).toContain('O');
		});

		it('extracts S for sonnet models', () => {
			expect(createModelIdentifier('claude-sonnet-4-20250514', 1)).toContain('S');
			expect(createModelIdentifier('sonnet-4', 1)).toContain('S');
		});

		it('extracts H for haiku models', () => {
			expect(createModelIdentifier('claude-haiku-4-5-20250901', 2)).toContain('H');
		});

		it('extracts G for gpt models', () => {
			expect(createModelIdentifier('gpt-4o', 3)).toContain('G');
		});
	});

	describe('createModelLegendEntry', () => {
		it('creates full legend entry', () => {
			const result = createModelLegendEntry('opus-4-5', 0);
			expect(result).toContain('O');
			expect(result).toContain('opus-4-5');
			expect(result).toContain(LEGEND_BULLET);
		});
	});
}
