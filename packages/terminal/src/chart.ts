import process from 'node:process';
import pc from 'picocolors';
import stringWidth from 'string-width';

/**
 * Data point for chart rendering
 */
export type ChartDataPoint = {
	label: string;
	value: number;
	formattedValue?: string;
};

/**
 * Configuration options for chart rendering
 */
export type ChartOptions = {
	/** Title displayed above the chart */
	title?: string;
	/** Maximum bar width in characters (auto-calculated from terminal width if omitted) */
	maxBarWidth?: number;
	/** Character used for filled portion of bars */
	fillChar?: string;
	/** Character used for the bar tip (partial block) */
	tipChar?: string;
	/** Whether to show value labels to the right of bars */
	showValues?: boolean;
	/** Suffix appended to formatted values (e.g., " tokens") */
	valueSuffix?: string;
	/** Force compact layout for narrow terminals */
	forceCompact?: boolean;
};

/**
 * Formats a number as USD currency
 */
function formatCurrencyValue(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/**
 * Picks a color based on where a value falls within the range [0, max].
 * Low values get dim blue, mid gets cyan, high gets yellow, top gets bold green.
 */
function colorForValue(value: number, maxValue: number): (text: string) => string {
	if (maxValue <= 0) {
		return pc.gray;
	}
	const ratio = value / maxValue;
	if (ratio >= 0.95) {
		return (t: string) => pc.bold(pc.green(t));
	}
	if (ratio >= 0.65) {
		return pc.yellow;
	}
	if (ratio >= 0.35) {
		return pc.cyan;
	}
	if (ratio > 0) {
		return pc.blue;
	}
	return pc.gray;
}

/**
 * Renders a horizontal bar chart as a string for terminal output
 *
 * Features:
 * - Color gradient: bars transition from blue (low) -> cyan -> yellow -> bold green (peak)
 * - Non-zero values always show at least a thin bar (▏) so nothing is invisible
 * - Cost values are placed right next to bars for easy reading
 * - Fractional block characters (▏▎▍▌▋▊▉█) for sub-character precision
 *
 * @param data - Array of data points to render
 * @param options - Chart display options
 * @returns Formatted chart string ready for terminal output
 */
export function renderBarChart(data: ChartDataPoint[], options: ChartOptions = {}): string {
	if (data.length === 0) {
		return '';
	}

	const { fillChar = '█', tipChar = '▏', showValues = true, forceCompact = false } = options;

	// Sub-character block elements for fractional widths (⅛ increments)
	const fractionalBlocks = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

	// Determine terminal width
	const terminalWidth =
		Number.parseInt(process.env.COLUMNS ?? '', 10) || process.stdout.columns || 120;

	// Calculate label width (max label length + padding)
	const maxLabelWidth = Math.max(...data.map((d) => stringWidth(d.label)));
	const labelWidth = maxLabelWidth + 2; // 2 chars padding

	// Calculate value width
	const formattedValues = data.map((d) => d.formattedValue ?? formatCurrencyValue(d.value));
	const maxValueWidth = Math.max(...formattedValues.map((v) => stringWidth(v)));
	const valueWidth = showValues ? maxValueWidth + 2 : 0; // 2 chars padding

	// Calculate available bar width
	const overhead = labelWidth + valueWidth + 4; // spacing between sections
	const maxBarWidth =
		options.maxBarWidth ??
		Math.max(10, (forceCompact ? Math.min(terminalWidth, 60) : terminalWidth) - overhead);

	// Find max value for scaling
	const maxValue = Math.max(...data.map((d) => d.value), 0);

	const lines: string[] = [];

	for (let i = 0; i < data.length; i++) {
		const point = data[i]!;
		const formattedValue = formattedValues[i]!;

		// Pad label to consistent width (right-align)
		const labelPad = labelWidth - stringWidth(point.label);
		const paddedLabel = ' '.repeat(labelPad) + pc.white(point.label);

		// Calculate bar length with fractional precision
		const exactBarWidth = maxValue > 0 ? (point.value / maxValue) * maxBarWidth : 0;
		const fullBlocks = Math.floor(exactBarWidth);
		const fractionalIndex = Math.round((exactBarWidth - fullBlocks) * 8);
		const fractional = fractionalBlocks[fractionalIndex] ?? '';

		// Ensure non-zero values always show at least a minimal bar
		let bar: string;
		if (point.value === 0) {
			bar = '';
		} else if (fullBlocks === 0 && fractional === '') {
			bar = tipChar; // minimum visible bar for tiny values
		} else {
			bar = fillChar.repeat(fullBlocks) + fractional;
		}

		const barVisualWidth = stringWidth(bar);
		const barPadding = ' '.repeat(Math.max(0, maxBarWidth - barVisualWidth));

		// Apply gradient color based on value
		const colorFn = colorForValue(point.value, maxValue);
		const coloredBar = bar.length > 0 ? colorFn(bar) : '';

		// Color the value based on magnitude too
		const valueColorFn = point.value === 0 ? pc.gray : colorFn;
		const coloredValue = valueColorFn(formattedValue);

		// Build line
		let line = `${paddedLabel}  ${coloredBar}${barPadding}`;
		if (showValues) {
			const valuePad = maxValueWidth - stringWidth(formattedValue);
			line += `  ${' '.repeat(valuePad)}${coloredValue}`;
		}

		lines.push(line);
	}

	return lines.join('\n');
}

/**
 * Renders a separator line for visual separation in charts
 * @param width - Width of the separator line
 * @returns Formatted separator string
 */
export function renderChartSeparator(width?: number): string {
	const terminalWidth =
		width ?? (Number.parseInt(process.env.COLUMNS ?? '', 10) || process.stdout.columns || 120);
	const separatorWidth = Math.min(terminalWidth - 4, 60);
	return `  ${pc.gray('─'.repeat(separatorWidth))}`;
}

/**
 * Renders a totals line aligned with chart output
 * @param label - Label for the totals line (e.g., "Total")
 * @param formattedValue - Pre-formatted value string (e.g., "$35.10")
 * @param labelWidth - Width to use for label alignment
 * @returns Formatted totals string
 */
export function renderChartTotals(
	label: string,
	formattedValue: string,
	labelWidth?: number,
): string {
	const padWidth = (labelWidth ?? 12) - stringWidth(label);
	const paddedLabel = ' '.repeat(Math.max(0, padWidth)) + pc.bold(pc.yellow(label));
	return `${paddedLabel}  ${pc.bold(pc.yellow(formattedValue))}`;
}

/**
 * Creates chart data from usage data with cost as the displayed metric
 *
 * @param items - Array of usage items with a label key and cost
 * @param labelKey - Key to use for the chart label
 * @param options - Additional options
 * @param options.costKey - Key to use for the cost value (default: 'totalCost')
 * @param options.labelFormatter - Function to format label values
 * @returns Array of ChartDataPoint for rendering
 */
export function createCostChartData<T extends Record<string, unknown>>(
	items: T[],
	labelKey: keyof T & string,
	options?: {
		costKey?: keyof T & string;
		labelFormatter?: (value: string) => string;
	},
): ChartDataPoint[] {
	const costKey = options?.costKey ?? ('totalCost' as keyof T & string);
	const labelFormatter = options?.labelFormatter;

	return items.map((item) => {
		const rawLabel = String(item[labelKey]);
		const label = labelFormatter != null ? labelFormatter(rawLabel) : rawLabel;
		const value = Number(item[costKey]);
		return {
			label,
			value,
			formattedValue: formatCurrencyValue(value),
		};
	});
}

if (import.meta.vitest != null) {
	describe('renderBarChart', () => {
		it('should render a basic bar chart', () => {
			const data: ChartDataPoint[] = [
				{ label: '2026-03-28', value: 12.45, formattedValue: '$12.45' },
				{ label: '2026-03-29', value: 8.2, formattedValue: '$8.20' },
				{ label: '2026-03-30', value: 4.0, formattedValue: '$4.00' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			// Strip ANSI codes for content assertions
			const output = renderBarChart(data);

			expect(output).toContain('2026-03-28');
			expect(output).toContain('2026-03-29');
			expect(output).toContain('2026-03-30');
			expect(output).toContain('$12.45');
			expect(output).toContain('$8.20');
			expect(output).toContain('$4.00');

			process.env.COLUMNS = originalColumns;
		});

		it('should handle empty data', () => {
			const output = renderBarChart([]);
			expect(output).toBe('');
		});

		it('should handle single data point', () => {
			const data: ChartDataPoint[] = [{ label: 'Jan', value: 10.0, formattedValue: '$10.00' }];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const output = renderBarChart(data);
			expect(output).toContain('Jan');
			expect(output).toContain('$10.00');
			// Single data point should get full bar width
			expect((output.match(/█/g) ?? []).length).toBeGreaterThan(0);

			process.env.COLUMNS = originalColumns;
		});

		it('should show minimal bar for tiny non-zero values', () => {
			const data: ChartDataPoint[] = [
				{ label: 'A', value: 0.01, formattedValue: '$0.01' },
				{ label: 'B', value: 100, formattedValue: '$100.00' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const output = renderBarChart(data);
			const lines = output.split('\n');
			// First line (tiny value) should still have a visible bar character
			expect(lines[0]).toMatch(/[▏▎▍▌▋▊▉█]/);

			process.env.COLUMNS = originalColumns;
		});

		it('should handle zero values with no bar', () => {
			const data: ChartDataPoint[] = [
				{ label: 'A', value: 0, formattedValue: '$0.00' },
				{ label: 'B', value: 5, formattedValue: '$5.00' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const output = renderBarChart(data);
			const lines = output.split('\n');
			// First line (value=0) should have no bar characters
			expect(lines[0]).not.toMatch(/[▏▎▍▌▋▊▉█]/);
			// Second line should have bars
			expect(lines[1]).toMatch(/█/);

			process.env.COLUMNS = originalColumns;
		});

		it('should respect forceCompact option', () => {
			const data: ChartDataPoint[] = [{ label: 'Day 1', value: 10, formattedValue: '$10.00' }];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '120';

			const normalOutput = renderBarChart(data);
			const compactOutput = renderBarChart(data, { forceCompact: true });

			// Compact output should be shorter or equal
			expect(stringWidth(normalOutput)).toBeGreaterThanOrEqual(stringWidth(compactOutput));

			process.env.COLUMNS = originalColumns;
		});
	});

	describe('colorForValue', () => {
		it('should return gray for zero value', () => {
			const color = colorForValue(0, 100);
			expect(color('test')).toBe(pc.gray('test'));
		});

		it('should return bold green for peak value', () => {
			const color = colorForValue(100, 100);
			expect(color('test')).toBe(pc.bold(pc.green('test')));
		});

		it('should return blue for low values', () => {
			const color = colorForValue(10, 100);
			expect(color('test')).toBe(pc.blue('test'));
		});

		it('should return cyan for mid values', () => {
			const color = colorForValue(50, 100);
			expect(color('test')).toBe(pc.cyan('test'));
		});

		it('should return yellow for high values', () => {
			const color = colorForValue(75, 100);
			expect(color('test')).toBe(pc.yellow('test'));
		});
	});

	describe('renderChartSeparator', () => {
		it('should render a separator line', () => {
			const separator = renderChartSeparator(80);
			expect(separator).toContain('─');
		});
	});

	describe('renderChartTotals', () => {
		it('should render bold yellow totals', () => {
			const totals = renderChartTotals('Total', '$100.00', 12);
			expect(totals).toContain('Total');
			expect(totals).toContain('$100.00');
		});
	});

	describe('createCostChartData', () => {
		it('should create chart data from usage items', () => {
			const items = [
				{ date: '2026-03-28', totalCost: 12.45 },
				{ date: '2026-03-29', totalCost: 8.2 },
			];

			const data = createCostChartData(items, 'date');

			expect(data).toHaveLength(2);
			expect(data[0]?.label).toBe('2026-03-28');
			expect(data[0]?.value).toBe(12.45);
			expect(data[0]?.formattedValue).toBe('$12.45');
			expect(data[1]?.label).toBe('2026-03-29');
			expect(data[1]?.value).toBe(8.2);
			expect(data[1]?.formattedValue).toBe('$8.20');
		});

		it('should apply label formatter', () => {
			const items = [{ month: '2026-03', totalCost: 50.0 }];

			const data = createCostChartData(items, 'month', {
				labelFormatter: (v) => `Month: ${v}`,
			});

			expect(data[0]?.label).toBe('Month: 2026-03');
		});

		it('should use custom cost key', () => {
			const items = [{ label: 'test', costUSD: 25.0 }];

			const data = createCostChartData(items, 'label', { costKey: 'costUSD' });

			expect(data[0]?.value).toBe(25.0);
		});
	});
}
