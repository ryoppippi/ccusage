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
	/** Optional group key for visual separators (e.g., "2026-03" for month grouping) */
	group?: string;
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
 * Uses a cold-to-hot thermal gradient that reads well on dark terminals:
 * dim cyan (cold/low) → cyan → green → yellow → red → bold red (hot/peak).
 */
function colorForValue(value: number, maxValue: number): (text: string) => string {
	if (maxValue <= 0) {
		return pc.gray;
	}
	const ratio = value / maxValue;
	if (ratio >= 0.95) {
		return (t: string) => pc.bold(pc.red(t));
	}
	if (ratio >= 0.75) {
		return pc.red;
	}
	if (ratio >= 0.55) {
		return pc.yellow;
	}
	if (ratio >= 0.35) {
		return pc.green;
	}
	if (ratio >= 0.15) {
		return pc.cyan;
	}
	if (ratio > 0) {
		return (t: string) => pc.dim(pc.cyan(t));
	}
	return pc.gray;
}

/**
 * Renders a horizontal bar chart as a string for terminal output
 *
 * Features:
 * - Color gradient: dim cyan (cold) -> cyan -> green -> yellow -> red -> bold red (hot)
 * - Non-zero values always show at least a thin bar (▏) so nothing is invisible
 * - Cost values placed immediately after the bar for easy scanning
 * - Automatic month/group separators when data spans multiple groups
 * - Background track (░) for visual reference of the scale
 *
 * @param data - Array of data points to render
 * @param options - Chart display options
 * @returns Object with the chart string and layout metrics for aligning totals
 */
export function renderBarChart(
	data: ChartDataPoint[],
	options: ChartOptions = {},
): { output: string; labelWidth: number; barWidth: number; valueWidth: number } {
	if (data.length === 0) {
		return { output: '', labelWidth: 0, barWidth: 0, valueWidth: 0 };
	}

	const { fillChar = '█', showValues = true, forceCompact = false } = options;

	// Determine terminal width
	const terminalWidth =
		Number.parseInt(process.env.COLUMNS ?? '', 10) || process.stdout.columns || 120;

	// Calculate label width (max label length + padding)
	const maxLabelWidth = Math.max(...data.map((d) => stringWidth(d.label)));
	const labelWidth = maxLabelWidth + 2; // 2 chars padding

	// Calculate value width
	const formattedValues = data.map((d) => d.formattedValue ?? formatCurrencyValue(d.value));
	const maxValueWidth = Math.max(...formattedValues.map((v) => stringWidth(v)));

	// Calculate available bar width — leave room for label + gap + bar + gap + value
	const overhead = labelWidth + 3 + maxValueWidth + 1; // "label  bar value"
	const maxBarWidth =
		options.maxBarWidth ??
		Math.max(10, (forceCompact ? Math.min(terminalWidth, 60) : terminalWidth) - overhead);

	// Find max value for scaling
	const maxValue = Math.max(...data.map((d) => d.value), 0);

	// Month name lookup for group headers
	const monthNames = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December',
	];

	/**
	 * Converts a YYYY-MM group key to a readable month label (e.g., "March 2026")
	 */
	function formatGroupLabel(group: string): string | undefined {
		const match = group.match(/^(\d{4})-(\d{2})$/);
		if (match == null) {
			return undefined;
		}
		const year = match[1];
		const monthIndex = Number.parseInt(match[2]!, 10) - 1;
		const name = monthNames[monthIndex];
		if (name == null) {
			return undefined;
		}
		return `${name} ${year}`;
	}

	const lines: string[] = [];
	let lastGroup: string | undefined;

	for (let i = 0; i < data.length; i++) {
		const point = data[i]!;
		const formattedValue = formattedValues[i]!;

		// Insert group separator with month label when group changes
		if (point.group != null && point.group !== lastGroup) {
			if (lastGroup != null) {
				lines.push(''); // blank line
			}
			const groupLabel = formatGroupLabel(point.group);
			if (groupLabel != null) {
				const pad = ' '.repeat(Math.max(0, labelWidth - stringWidth(groupLabel)));
				lines.push(`${pad}${pc.bold(pc.white(groupLabel))}`);
			}
			lastGroup = point.group;
		}

		// Pad label to consistent width (right-align), dim the label
		const labelPad = labelWidth - stringWidth(point.label);
		const paddedLabel = ' '.repeat(labelPad) + pc.dim(pc.white(point.label));

		// Calculate bar length (integer only — no fractional blocks to avoid stripy look)
		const barLength = maxValue > 0 ? Math.round((point.value / maxValue) * maxBarWidth) : 0;

		// Ensure non-zero values always show at least 1 block
		const effectiveBarLength = point.value > 0 ? Math.max(1, barLength) : 0;

		// Build bar with background track
		const bar = fillChar.repeat(effectiveBarLength);
		const track = pc.gray('░'.repeat(Math.max(0, maxBarWidth - effectiveBarLength)));

		// Apply gradient color based on value
		const colorFn = colorForValue(point.value, maxValue);
		const coloredBar = bar.length > 0 ? colorFn(bar) : '';

		// Color the value to match the bar
		const valueColorFn = point.value === 0 ? pc.gray : colorFn;
		const coloredValue = valueColorFn(formattedValue);

		// Build line — value immediately after bar (no right-align to edge)
		let line = `${paddedLabel} ${coloredBar}${track}`;
		if (showValues) {
			line += ` ${coloredValue}`;
		}

		lines.push(line);
	}

	return { output: lines.join('\n'), labelWidth, barWidth: maxBarWidth, valueWidth: maxValueWidth };
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
 * Renders a totals line with label and value together on the left
 * @param label - Label for the totals line (e.g., "Total")
 * @param formattedValue - Pre-formatted value string (e.g., "$35.10")
 * @param labelWidth - Width used for labels in the chart (from renderBarChart result)
 * @returns Formatted totals string
 */
/**
 * Renders a totals line right-aligned so the value ends at the same column as chart cost values
 * @param label - Label for the totals line (e.g., "Total")
 * @param formattedValue - Pre-formatted value string (e.g., "$35.10")
 * @param labelWidth - Width used for labels in the chart (from renderBarChart result)
 * @param barWidth - Width used for bars in the chart (from renderBarChart result)
 * @param valueWidth - Width of the widest value in the chart (from renderBarChart result)
 * @returns Formatted totals string
 */
export function renderChartTotals(
	label: string,
	formattedValue: string,
	labelWidth: number,
	barWidth: number,
	valueWidth: number,
): string {
	// Chart row end position: labelWidth(pad+label) + " " + barWidth(bar+track) + " " + valueWidth
	const rowEndCol = labelWidth + 1 + barWidth + 1 + valueWidth;
	// Right-pad value to match valueWidth so the last char aligns
	const valuePad = Math.max(0, valueWidth - stringWidth(formattedValue));
	const paddedValue = ' '.repeat(valuePad) + formattedValue;
	const paddedTotalWidth = stringWidth(label) + 2 + valueWidth;
	const leftPad = Math.max(0, rowEndCol - paddedTotalWidth);
	return `${' '.repeat(leftPad)}${pc.bold(pc.yellow(label))}  ${pc.bold(pc.yellow(paddedValue))}`;
}

/**
 * Creates chart data from usage data with cost as the displayed metric.
 * Automatically groups by month when the label looks like a date (YYYY-MM-DD).
 *
 * @param items - Array of usage items with a label key and cost
 * @param labelKey - Key to use for the chart label
 * @param options - Additional options
 * @param options.costKey - Key to use for the cost value (default: 'totalCost')
 * @param options.labelFormatter - Function to format label values
 * @param options.groupBy - Function to extract group key for visual separators
 * @returns Array of ChartDataPoint for rendering
 */
export function createCostChartData<T extends Record<string, unknown>>(
	items: T[],
	labelKey: keyof T & string,
	options?: {
		costKey?: keyof T & string;
		labelFormatter?: (value: string) => string;
		groupBy?: (value: string) => string;
	},
): ChartDataPoint[] {
	const costKey = options?.costKey ?? ('totalCost' as keyof T & string);
	const labelFormatter = options?.labelFormatter;

	// Auto-detect date labels for month grouping
	const autoGroupByMonth = (val: string): string | undefined => {
		const match = val.match(/^(\d{4}-\d{2})/);
		return match?.[1];
	};

	return items.map((item) => {
		const rawLabel = String(item[labelKey]);
		const label = labelFormatter != null ? labelFormatter(rawLabel) : rawLabel;
		const value = Number(item[costKey]);

		// Determine group
		let group: string | undefined;
		if (options?.groupBy != null) {
			group = options.groupBy(rawLabel);
		} else {
			group = autoGroupByMonth(rawLabel);
		}

		return {
			label,
			value,
			formattedValue: formatCurrencyValue(value),
			group,
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

			const { output } = renderBarChart(data);

			expect(output).toContain('2026-03-28');
			expect(output).toContain('2026-03-29');
			expect(output).toContain('2026-03-30');
			expect(output).toContain('$12.45');
			expect(output).toContain('$8.20');
			expect(output).toContain('$4.00');

			process.env.COLUMNS = originalColumns;
		});

		it('should handle empty data', () => {
			const { output } = renderBarChart([]);
			expect(output).toBe('');
		});

		it('should handle single data point', () => {
			const data: ChartDataPoint[] = [{ label: 'Jan', value: 10.0, formattedValue: '$10.00' }];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const { output } = renderBarChart(data);
			expect(output).toContain('Jan');
			expect(output).toContain('$10.00');
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

			const { output } = renderBarChart(data);
			const lines = output.split('\n');
			// First line (tiny value) should still have at least one filled block
			expect(lines[0]).toMatch(/█/);

			process.env.COLUMNS = originalColumns;
		});

		it('should handle zero values with no bar', () => {
			const data: ChartDataPoint[] = [
				{ label: 'A', value: 0, formattedValue: '$0.00' },
				{ label: 'B', value: 5, formattedValue: '$5.00' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const { output } = renderBarChart(data);
			const lines = output.split('\n');
			// First line (value=0) should have no filled bar characters
			expect(lines[0]).not.toMatch(/█/);
			// Second line should have bars
			expect(lines[1]).toMatch(/█/);

			process.env.COLUMNS = originalColumns;
		});

		it('should render background track', () => {
			const data: ChartDataPoint[] = [
				{ label: 'A', value: 5, formattedValue: '$5.00' },
				{ label: 'B', value: 10, formattedValue: '$10.00' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const { output } = renderBarChart(data);
			// Should contain track characters
			expect(output).toContain('░');

			process.env.COLUMNS = originalColumns;
		});

		it('should insert group separators', () => {
			const data: ChartDataPoint[] = [
				{ label: '2026-01-15', value: 5, group: '2026-01' },
				{ label: '2026-02-01', value: 10, group: '2026-02' },
				{ label: '2026-02-02', value: 8, group: '2026-02' },
			];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '80';

			const { output } = renderBarChart(data);
			const lines = output.split('\n');
			// Should have a blank line between groups
			expect(lines.includes('')).toBe(true);

			process.env.COLUMNS = originalColumns;
		});

		it('should respect forceCompact option', () => {
			const data: ChartDataPoint[] = [{ label: 'Day 1', value: 10, formattedValue: '$10.00' }];

			const originalColumns = process.env.COLUMNS;
			process.env.COLUMNS = '120';

			const normal = renderBarChart(data);
			const compact = renderBarChart(data, { forceCompact: true });

			expect(stringWidth(normal.output)).toBeGreaterThanOrEqual(stringWidth(compact.output));

			process.env.COLUMNS = originalColumns;
		});
	});

	describe('colorForValue', () => {
		it('should return gray for zero value', () => {
			const color = colorForValue(0, 100);
			expect(color('test')).toBe(pc.gray('test'));
		});

		it('should return bold red for peak value', () => {
			const color = colorForValue(100, 100);
			expect(color('test')).toBe(pc.bold(pc.red('test')));
		});

		it('should return dim cyan for low values', () => {
			const color = colorForValue(10, 100);
			expect(color('test')).toBe(pc.dim(pc.cyan('test')));
		});

		it('should return cyan for low-mid values', () => {
			const color = colorForValue(25, 100);
			expect(color('test')).toBe(pc.cyan('test'));
		});

		it('should return green for mid values', () => {
			const color = colorForValue(45, 100);
			expect(color('test')).toBe(pc.green('test'));
		});

		it('should return yellow for high values', () => {
			const color = colorForValue(65, 100);
			expect(color('test')).toBe(pc.yellow('test'));
		});

		it('should return red for very high values', () => {
			const color = colorForValue(85, 100);
			expect(color('test')).toBe(pc.red('test'));
		});
	});

	describe('renderChartSeparator', () => {
		it('should render a separator line', () => {
			const separator = renderChartSeparator(80);
			expect(separator).toContain('─');
		});
	});

	describe('renderChartTotals', () => {
		it('should right-align totals with the cost column', () => {
			const totals = renderChartTotals('Total', '$100.00', 12, 40, 7);
			expect(totals).toContain('Total');
			expect(totals).toContain('$100.00');
			// Should have left padding to push it right
			expect(totals.startsWith(' ')).toBe(true);
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

		it('should auto-detect month groups from date labels', () => {
			const items = [
				{ date: '2026-01-15', totalCost: 5 },
				{ date: '2026-02-01', totalCost: 10 },
			];

			const data = createCostChartData(items, 'date');

			expect(data[0]?.group).toBe('2026-01');
			expect(data[1]?.group).toBe('2026-02');
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

		it('should use custom groupBy function', () => {
			const items = [
				{ week: '2026-W01', totalCost: 5 },
				{ week: '2026-W05', totalCost: 10 },
			];

			const data = createCostChartData(items, 'week', {
				groupBy: (v) => v.slice(0, 4),
			});

			expect(data[0]?.group).toBe('2026');
			expect(data[1]?.group).toBe('2026');
		});
	});
}
