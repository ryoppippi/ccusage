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
	/** Whether to show value labels to the right of bars */
	showValues?: boolean;
	/** Color function applied to bars (from picocolors) */
	barColor?: (text: string) => string;
	/** Color function applied to the max-value bar */
	maxBarColor?: (text: string) => string;
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
 * Renders a horizontal bar chart as a string for terminal output
 *
 * Example output:
 *   2026-03-28  ████████████████████████████████████  $12.45
 *   2026-03-29  ██████████████████████               $8.20
 *   Total                                             $35.10
 *
 * @param data - Array of data points to render
 * @param options - Chart display options
 * @returns Formatted chart string ready for terminal output
 */
export function renderBarChart(data: ChartDataPoint[], options: ChartOptions = {}): string {
	if (data.length === 0) {
		return '';
	}

	const {
		fillChar = '█',
		showValues = true,
		barColor = pc.cyan,
		maxBarColor = pc.green,
		forceCompact = false,
	} = options;

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
		const paddedLabel = ' '.repeat(labelPad) + point.label;

		// Calculate bar length
		const barLength = maxValue > 0 ? Math.round((point.value / maxValue) * maxBarWidth) : 0;
		const bar = fillChar.repeat(barLength);
		const barPadding = ' '.repeat(maxBarWidth - barLength);

		// Apply color - highlight the max value bar
		const colorFn = point.value === maxValue && maxValue > 0 ? maxBarColor : barColor;
		const coloredBar = bar.length > 0 ? colorFn(bar) : '';

		// Build line
		let line = `${paddedLabel}  ${coloredBar}${barPadding}`;
		if (showValues) {
			const valuePad = maxValueWidth - stringWidth(formattedValue);
			line += `  ${' '.repeat(valuePad)}${formattedValue}`;
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
	const paddedLabel = ' '.repeat(Math.max(0, padWidth)) + pc.yellow(label);
	return `${paddedLabel}  ${pc.yellow(formattedValue)}`;
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

			const output = renderBarChart(data, { barColor: (t) => t, maxBarColor: (t) => t });

			expect(output).toContain('2026-03-28');
			expect(output).toContain('2026-03-29');
			expect(output).toContain('2026-03-30');
			expect(output).toContain('$12.45');
			expect(output).toContain('$8.20');
			expect(output).toContain('$4.00');

			// The first row should have the longest bar (highest value)
			const lines = output.split('\n');
			const bar1Length = (lines[0]?.match(/█/g) ?? []).length;
			const bar2Length = (lines[1]?.match(/█/g) ?? []).length;
			const bar3Length = (lines[2]?.match(/█/g) ?? []).length;

			expect(bar1Length).toBeGreaterThan(bar2Length);
			expect(bar2Length).toBeGreaterThan(bar3Length);

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

			const output = renderBarChart(data, { barColor: (t) => t, maxBarColor: (t) => t });
			expect(output).toContain('Jan');
			expect(output).toContain('$10.00');
			// Single data point should get full bar width
			expect((output.match(/█/g) ?? []).length).toBeGreaterThan(0);

			process.env.COLUMNS = originalColumns;
		});

		it('should handle zero values', () => {
			const data: ChartDataPoint[] = [
				{ label: 'A', value: 0, formattedValue: '$0.00' },
				{ label: 'B', value: 5, formattedValue: '$5.00' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const output = renderBarChart(data, { barColor: (t) => t, maxBarColor: (t) => t });
			const lines = output.split('\n');
			// First line (value=0) should have no bar characters
			expect(lines[0]?.match(/█/g) ?? []).toHaveLength(0);
			// Second line should have bars
			expect((lines[1]?.match(/█/g) ?? []).length).toBeGreaterThan(0);

			process.env.COLUMNS = originalColumns;
		});

		it('should respect forceCompact option', () => {
			const data: ChartDataPoint[] = [{ label: 'Day 1', value: 10, formattedValue: '$10.00' }];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '120';

			const normalOutput = renderBarChart(data, { barColor: (t) => t, maxBarColor: (t) => t });
			const compactOutput = renderBarChart(data, {
				forceCompact: true,
				barColor: (t) => t,
				maxBarColor: (t) => t,
			});

			// Compact output should be shorter or equal
			expect(normalOutput.length).toBeGreaterThanOrEqual(compactOutput.length);

			process.env.COLUMNS = originalColumns;
		});
	});

	describe('renderChartSeparator', () => {
		it('should render a separator line', () => {
			const separator = renderChartSeparator(80);
			// Should contain dash characters (may be wrapped in ANSI codes)
			expect(separator).toContain('─');
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
