import type { DeviationThresholds } from './colors.ts';
import { colors } from './colors.ts';

/**
 * Sparkline utilities for Tufte-style terminal visualizations.
 * Creates compact, word-sized graphics for data trends.
 */

/**
 * Unicode block characters for 8-level sparklines.
 * Ordered from lowest (index 0) to highest (index 7).
 */
export const SPARK_CHARS = [
	'\u2581', // LOWER ONE EIGHTH BLOCK
	'\u2582', // LOWER ONE QUARTER BLOCK
	'\u2583', // LOWER THREE EIGHTHS BLOCK
	'\u2584', // LOWER HALF BLOCK
	'\u2585', // LOWER FIVE EIGHTHS BLOCK
	'\u2586', // LOWER THREE QUARTERS BLOCK
	'\u2587', // LOWER SEVEN EIGHTHS BLOCK
	'\u2588', // FULL BLOCK
] as const;

/**
 * Options for sparkline generation.
 */
export type SparklineOptions = {
	/** Minimum value for scaling (defaults to min in data) */
	min?: number;
	/** Maximum value for scaling (defaults to max in data) */
	max?: number;
	/** Target width in characters (defaults to data length) */
	width?: number;
	/** Apply color gradient based on value (green to red) */
	colorize?: boolean;
	/** Thresholds for colorization */
	thresholds?: DeviationThresholds;
};

/**
 * Create a sparkline from an array of numeric values.
 *
 * @param values - Array of numbers to visualize
 * @param options - Configuration options
 * @returns Sparkline string of block characters
 *
 * @example
 * createSparkline([1, 5, 3, 8, 2])
 * // Returns: "▁▅▃█▂"
 */
export function createSparkline(values: number[], options: SparklineOptions = {}): string {
	if (values.length === 0) {
		return '';
	}

	// handle single value
	if (values.length === 1) {
		return SPARK_CHARS[4]; // middle bar
	}

	const min = options.min ?? Math.min(...values);
	const max = options.max ?? Math.max(...values);
	const range = max - min;

	// if all values are the same, show middle bars
	if (range === 0) {
		return SPARK_CHARS[4].repeat(values.length);
	}

	// map each value to a spark character
	const chars = values.map((value) => {
		// normalize to 0-1 range
		const normalized = (value - min) / range;
		// map to character index (0-7)
		const index = Math.min(7, Math.floor(normalized * 8));
		return SPARK_CHARS[index];
	});

	// handle width resizing if requested
	if (options.width != null && options.width !== values.length) {
		return resizeSparkline(chars.join(''), options.width);
	}

	return chars.join('');
}

/**
 * Resize a sparkline to a target width by sampling or interpolating.
 */
function resizeSparkline(sparkline: string, targetWidth: number): string {
	const chars = [...sparkline];
	const sourceLength = chars.length;

	if (targetWidth >= sourceLength) {
		// expand: repeat characters to fill target width
		// baseRepeat is the minimum times each char repeats
		// first extraChars positions get one more repeat to fill remaining space
		const baseRepeat = Math.floor(targetWidth / sourceLength);
		const extraChars = targetWidth - baseRepeat * sourceLength;
		return chars
			.map((char, i) => char.repeat(i < extraChars ? baseRepeat + 1 : baseRepeat))
			.join('');
	}

	// shrink: sample characters
	const result: string[] = [];
	for (let i = 0; i < targetWidth; i++) {
		const sourceIndex = Math.floor((i / targetWidth) * sourceLength);
		const char = chars[sourceIndex];
		if (char != null) {
			result.push(char);
		}
	}
	return result.join('');
}

/**
 * Options for labeled sparklines with annotations.
 */
export type LabeledSparklineOptions = {
	/** Label for the metric (e.g., "Cost") */
	label?: string;
	/** Format function for values */
	formatValue?: (value: number) => string;
	/** Show average value */
	showAverage?: boolean;
} & SparklineOptions;

/**
 * Create a sparkline with min/max labels and optional statistics.
 *
 * @example
 * createLabeledSparkline([1.5, 5.2, 3.1, 8.0, 2.3], {
 *   label: 'Cost',
 *   formatValue: (v) => `$${v.toFixed(2)}`
 * })
 * // Returns: "Cost     ▁▅▃█▂  $1.50->$8.00  avg $4.02"
 */
export function createLabeledSparkline(
	values: number[],
	options: LabeledSparklineOptions = {},
): string {
	if (values.length === 0) {
		return options.label != null && options.label !== ''
			? `${options.label}  (no data)`
			: '(no data)';
	}

	const sparkline = createSparkline(values, options);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const formatValue = options.formatValue ?? ((v: number) => v.toFixed(2));

	const parts: string[] = [];

	if (options.label != null && options.label !== '') {
		parts.push(options.label.padEnd(8));
	}

	parts.push(sparkline);
	parts.push(` ${formatValue(min)}->${formatValue(max)}`);

	if (options.showAverage === true) {
		const avg = values.reduce((a, b) => a + b, 0) / values.length;
		parts.push(`  avg ${formatValue(avg)}`);
	}

	return parts.join('');
}

/**
 * Usage entry with timestamp for intra-day grouping.
 */
export type TimestampedEntry = {
	timestamp: string; // ISO timestamp
	outputTokens: number;
	inputTokens?: number;
	cost?: number;
};

/**
 * Create an intra-day sparkline showing activity across 24 hours.
 * Groups data into 2-hour windows (12 bars total).
 *
 * @param entries - Usage entries with timestamps
 * @param metric - Which metric to visualize ('output' | 'cost')
 * @returns 12-character sparkline representing midnight to midnight
 */
export function createIntradaySparkline(
	entries: TimestampedEntry[],
	metric: 'output' | 'cost' = 'output',
): string {
	// create 12 buckets for 2-hour windows
	const buckets: number[] = Array.from({ length: 12 }, () => 0);

	for (const entry of entries) {
		const date = new Date(entry.timestamp);
		const hour = date.getHours();
		const bucketIndex = Math.floor(hour / 2); // 0-11

		const value = metric === 'cost' ? (entry.cost ?? 0) : entry.outputTokens;
		const currentBucket = buckets[bucketIndex] ?? 0;
		buckets[bucketIndex] = currentBucket + value;
	}

	return createSparkline(buckets);
}

/**
 * Sparkline summary row configuration.
 */
export type SparklineSummaryRow = {
	label: string;
	values: number[];
	formatValue: (value: number) => string;
	annotation?: string;
};

/**
 * Create a multi-row sparkline summary for display after tables.
 *
 * @param rows - Array of summary row configurations
 * @param terminalWidth - Available width for sparklines
 * @returns Formatted summary string with multiple sparkline rows
 */
export function createSparklineSummary(rows: SparklineSummaryRow[], terminalWidth = 80): string {
	if (rows.length === 0) {
		return '';
	}

	// calculate sparkline width
	// format: "Label    ▁▂▃▄▅▆▇█  min->max  annotation"
	const labelWidth = 9;
	const statsWidth = 30; // space for min->max and annotation
	const sparkWidth = Math.max(10, terminalWidth - labelWidth - statsWidth);

	const lines: string[] = [];

	// divider line
	lines.push('\u2500'.repeat(terminalWidth));

	for (const row of rows) {
		if (row.values.length === 0) {
			continue;
		}

		const sparkline = createSparkline(row.values, { width: sparkWidth });
		const min = Math.min(...row.values);
		const max = Math.max(...row.values);
		const avg = row.values.reduce((a, b) => a + b, 0) / row.values.length;

		let line = row.label.padEnd(labelWidth);
		line += sparkline;
		line += `  ${row.formatValue(min)}->${row.formatValue(max)}`;

		if (row.annotation != null && row.annotation !== '') {
			line += `  ${colors.text.secondary(row.annotation)}`;
		} else {
			line += `  avg ${row.formatValue(avg)}`;
		}

		lines.push(line);
	}

	return lines.join('\n');
}

/**
 * Format a number with compact notation (K, M, B).
 */
export function formatTokensCompact(n: number): string {
	if (n >= 1_000_000_000) {
		return `${(n / 1_000_000_000).toFixed(1)}B`;
	}
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(0)}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(0)}K`;
	}
	return n.toString();
}

/**
 * Format a currency value compactly.
 */
export function formatCostCompact(n: number): string {
	if (n >= 1000) {
		return `$${(n / 1000).toFixed(1)}K`;
	}
	if (n >= 100) {
		return `$${Math.round(n)}`;
	}
	return `$${n.toFixed(2)}`;
}

// in-source tests
if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('SPARK_CHARS', () => {
		it('has 8 levels of block characters', () => {
			expect(SPARK_CHARS).toHaveLength(8);
			expect(SPARK_CHARS[0]).toBe('\u2581');
			expect(SPARK_CHARS[7]).toBe('\u2588');
		});
	});

	describe('createSparkline', () => {
		it('returns empty string for empty array', () => {
			expect(createSparkline([])).toBe('');
		});

		it('returns middle bar for single value', () => {
			expect(createSparkline([5])).toBe(SPARK_CHARS[4]);
		});

		it('returns all middle bars for same values', () => {
			expect(createSparkline([5, 5, 5])).toBe(SPARK_CHARS[4].repeat(3));
		});

		it('maps min to lowest bar and max to highest', () => {
			const result = createSparkline([0, 100]);
			expect(result[0]).toBe(SPARK_CHARS[0]);
			expect(result[1]).toBe(SPARK_CHARS[7]);
		});

		it('creates proportional sparkline', () => {
			const result = createSparkline([1, 5, 3, 8, 2]);
			expect(result).toHaveLength(5);
			// verify relative heights make sense
			const chars = [...result];
			const char3 = chars[3] as (typeof SPARK_CHARS)[number];
			const char0 = chars[0] as (typeof SPARK_CHARS)[number];
			expect(SPARK_CHARS.indexOf(char3)).toBeGreaterThan(SPARK_CHARS.indexOf(char0)); // 8 > 1
		});

		it('respects custom min/max', () => {
			const result = createSparkline([50], { min: 0, max: 100 });
			expect(result).toBe(SPARK_CHARS[4]); // 50 is middle
		});
	});

	describe('createIntradaySparkline', () => {
		it('returns 12 characters for 2-hour windows', () => {
			const entries: TimestampedEntry[] = [
				{ timestamp: '2025-01-01T08:00:00Z', outputTokens: 100 },
				{ timestamp: '2025-01-01T10:00:00Z', outputTokens: 200 },
				{ timestamp: '2025-01-01T14:00:00Z', outputTokens: 300 },
			];
			const result = createIntradaySparkline(entries);
			expect(result).toHaveLength(12);
		});

		it('groups tokens into correct 2-hour buckets', () => {
			const entries: TimestampedEntry[] = [
				{ timestamp: '2025-01-01T00:30:00Z', outputTokens: 100 }, // bucket 0 (00-02)
				{ timestamp: '2025-01-01T01:30:00Z', outputTokens: 100 }, // bucket 0 (00-02)
				{ timestamp: '2025-01-01T02:30:00Z', outputTokens: 50 }, // bucket 1 (02-04)
			];
			const result = createIntradaySparkline(entries);
			// bucket 0 has 200, bucket 1 has 50, so bucket 0 should be higher
			const char0 = result[0] as (typeof SPARK_CHARS)[number];
			const char1 = result[1] as (typeof SPARK_CHARS)[number];
			expect(SPARK_CHARS.indexOf(char0)).toBeGreaterThan(SPARK_CHARS.indexOf(char1));
		});
	});

	describe('formatTokensCompact', () => {
		it('formats billions', () => {
			expect(formatTokensCompact(1_500_000_000)).toBe('1.5B');
		});

		it('formats millions', () => {
			expect(formatTokensCompact(585_000_000)).toBe('585M');
		});

		it('formats thousands', () => {
			expect(formatTokensCompact(951_000)).toBe('951K');
		});

		it('keeps small numbers as-is', () => {
			expect(formatTokensCompact(80)).toBe('80');
		});
	});

	describe('formatCostCompact', () => {
		it('formats large costs with K suffix', () => {
			expect(formatCostCompact(1500)).toBe('$1.5K');
		});

		it('formats medium costs without decimals', () => {
			expect(formatCostCompact(786)).toBe('$786');
		});

		it('formats small costs with decimals', () => {
			expect(formatCostCompact(3.37)).toBe('$3.37');
		});
	});

	describe('createLabeledSparkline', () => {
		it('creates labeled sparkline with statistics', () => {
			const result = createLabeledSparkline([1, 5, 3, 8, 2], {
				label: 'Cost',
				formatValue: (v) => `$${v.toFixed(0)}`,
				showAverage: true,
			});
			expect(result).toContain('Cost');
			expect(result).toContain('$1->$8');
			expect(result).toContain('avg');
		});

		it('handles empty values', () => {
			const result = createLabeledSparkline([], { label: 'Cost' });
			expect(result).toContain('no data');
		});
	});
}
