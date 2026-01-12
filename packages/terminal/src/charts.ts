import { colors } from './colors.ts';
import { createSparkline, formatCostCompact, formatTokensCompact } from './sparkline.ts';

/**
 * Chart utilities for Tufte-style terminal visualizations.
 * Provides bar charts, full-width sparklines, and heatmaps.
 */

/**
 * Parse YYYY-MM-DD date string as local timezone date.
 * Using new Date('YYYY-MM-DD') treats the string as UTC, which can shift
 * dates for users in negative UTC offset timezones.
 */
function parseLocalDate(dateStr: string): Date {
	const [year, month, day] = dateStr.split('-').map(Number);
	return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

/**
 * Daily data entry for chart rendering.
 */
export type ChartDataEntry = {
	date: string; // YYYY-MM-DD format
	cost: number;
	outputTokens: number;
	inputTokens: number;
	cacheReadTokens?: number;
};

/**
 * Options for bar chart generation.
 */
export type BarChartOptions = {
	/** Target width for bars (defaults to terminal width - labels) */
	width?: number;
	/** Show values at end of bars */
	showValues?: boolean;
	/** Format function for values */
	formatValue?: (value: number) => string;
	/** Metric to visualize */
	metric?: 'cost' | 'output' | 'input';
};

/**
 * Create a horizontal bar chart from daily data.
 *
 * @example
 * createBarChart(dailyData, { width: 40 })
 * // Returns:
 * // Jan 07  ████████████████████████████████████  $786.91
 * // Jan 08  ██████████████████████████            $403.37
 */
export function createBarChart(data: ChartDataEntry[], options: BarChartOptions = {}): string {
	if (data.length === 0) {
		return '(no data)';
	}

	const metric = options.metric ?? 'cost';
	const getValue = (entry: ChartDataEntry): number => {
		switch (metric) {
			case 'cost':
				return entry.cost;
			case 'output':
				return entry.outputTokens;
			case 'input':
				return entry.inputTokens;
			default:
				return entry.cost;
		}
	};

	const formatValue =
		options.formatValue ?? (metric === 'cost' ? formatCostCompact : formatTokensCompact);

	const values = data.map(getValue);
	const maxValue = Math.max(...values);
	const width = options.width ?? 40;

	const lines: string[] = [];

	for (const entry of data) {
		const value = getValue(entry);
		const barLength = maxValue > 0 ? Math.round((value / maxValue) * width) : 0;
		const bar = '\u2588'.repeat(barLength);

		// format date as "Mon DD"
		const date = parseLocalDate(entry.date);
		const dateStr = date.toLocaleDateString('en-US', {
			month: 'short',
			day: '2-digit',
		});

		const valueStr = formatValue(value);
		lines.push(`${dateStr}  ${bar.padEnd(width)}  ${valueStr}`);
	}

	return lines.join('\n');
}

/**
 * Options for full-width sparkline.
 */
export type FullSparklineOptions = {
	/** Title for the chart */
	title?: string;
	/** Metric to visualize */
	metric?: 'cost' | 'output';
	/** Terminal width */
	terminalWidth?: number;
};

/**
 * Create a full-width annotated sparkline with peak markers.
 *
 * @example
 * createFullSparkline(dailyData, { title: 'Cost over time' })
 * // Returns:
 * // Cost over time (last 30 days)
 * //                                     ^ $786 (Jan 07)
 * //     ....sparkline characters....
 * // v $1.39 (Dec 09)
 * //
 * // Avg: $189/day  Total: $6,197.65
 */
export function createFullSparkline(
	data: ChartDataEntry[],
	options: FullSparklineOptions = {},
): string {
	if (data.length === 0) {
		return '(no data)';
	}

	const metric = options.metric ?? 'cost';
	const getValue = (entry: ChartDataEntry): number =>
		metric === 'cost' ? entry.cost : entry.outputTokens;
	const formatValue = metric === 'cost' ? formatCostCompact : formatTokensCompact;

	const values = data.map(getValue);
	const terminalWidth = options.terminalWidth ?? 80;
	const sparklineWidth = Math.min(values.length, terminalWidth - 10);

	const sparkline = createSparkline(values, { width: sparklineWidth });

	// find min and max with their dates
	let minValue = Infinity;
	let maxValue = -Infinity;
	let minDate = '';
	let maxDate = '';

	for (const entry of data) {
		const value = getValue(entry);
		if (value < minValue) {
			minValue = value;
			minDate = entry.date;
		}
		if (value > maxValue) {
			maxValue = value;
			maxDate = entry.date;
		}
	}

	const formatDate = (dateStr: string): string => {
		const date = new Date(dateStr);
		return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
	};

	// calculate statistics
	const total = values.reduce((a, b) => a + b, 0);
	const avg = total / values.length;

	const lines: string[] = [];

	// title
	const title = options.title ?? `${metric === 'cost' ? 'Cost' : 'Output'} over time`;
	lines.push(`${title} (last ${data.length} days)`);

	// max marker (positioned above sparkline)
	const maxPosition = data.findIndex((e) => e.date === maxDate);
	const maxMarkerPos = Math.floor((maxPosition / data.length) * sparklineWidth);
	const maxMarker = `${' '.repeat(maxMarkerPos)}^ ${formatValue(maxValue)} (${formatDate(maxDate)})`;
	lines.push(maxMarker);

	// sparkline
	lines.push(`    ${sparkline}`);

	// min marker (positioned below sparkline)
	const minPosition = data.findIndex((e) => e.date === minDate);
	const minMarkerPos = Math.floor((minPosition / data.length) * sparklineWidth);
	const minMarker = `${' '.repeat(minMarkerPos)}v ${formatValue(minValue)} (${formatDate(minDate)})`;
	lines.push(minMarker);

	// empty line
	lines.push('');

	// statistics
	const statsLine =
		metric === 'cost'
			? `Avg: ${formatValue(avg)}/day  Total: ${formatValue(total)}`
			: `Avg: ${formatValue(avg)}/day`;
	lines.push(statsLine);

	return lines.join('\n');
}

/**
 * Heatmap intensity levels.
 */
const HEATMAP_CHARS = [
	' ', // empty
	'\u2591', // LIGHT SHADE
	'\u2592', // MEDIUM SHADE
	'\u2593', // DARK SHADE
	'\u2588', // FULL BLOCK
] as const;

/**
 * Options for heatmap generation.
 */
export type HeatmapOptions = {
	/** Title for the heatmap */
	title?: string;
	/** Metric to visualize */
	metric?: 'cost' | 'output';
	/** Custom thresholds for intensity levels */
	thresholds?: number[];
};

/**
 * Create a calendar-style heatmap with 7-column week layout.
 *
 * @example
 * createHeatmap(dailyData)
 * // Returns:
 * // Usage Heatmap (by cost)
 * //         Mon   Tue   Wed   Thu   Fri   Sat   Sun
 * // Dec 09   -     -
 * // Dec 16   .     :     .     :     #     #     #
 * // ...
 * //   < $50   . $50-150   : $150-300   # > $300
 */
export function createHeatmap(data: ChartDataEntry[], options: HeatmapOptions = {}): string {
	if (data.length === 0) {
		return '(no data)';
	}

	const metric = options.metric ?? 'cost';
	const getValue = (entry: ChartDataEntry): number =>
		metric === 'cost' ? entry.cost : entry.outputTokens;

	const values = data.map(getValue);
	const maxValue = Math.max(...values);

	// calculate thresholds if not provided
	const thresholds = options.thresholds ?? [
		maxValue * 0.15, // level 1
		maxValue * 0.35, // level 2
		maxValue * 0.6, // level 3
		maxValue * 0.8, // level 4
	];

	const getIntensity = (value: number): number => {
		if (value === 0) {
			return 0;
		}
		for (let i = 0; i < thresholds.length; i++) {
			const threshold = thresholds[i];
			if (threshold != null && value <= threshold) {
				return i + 1;
			}
		}
		return 4;
	};

	// group data by week
	const weeks: Map<string, Map<number, ChartDataEntry>> = new Map();

	for (const entry of data) {
		const date = parseLocalDate(entry.date);
		const dayOfWeek = date.getDay(); // 0 = Sunday

		// get the Monday of this week
		const monday = new Date(date);
		const daysSinceMonday = (dayOfWeek + 6) % 7; // convert Sunday=0 to Monday=0
		monday.setDate(date.getDate() - daysSinceMonday);
		const weekKey = monday.toISOString().slice(0, 10);

		if (!weeks.has(weekKey)) {
			weeks.set(weekKey, new Map());
		}
		weeks.get(weekKey)!.set(dayOfWeek, entry);
	}

	const lines: string[] = [];

	// title
	const title = options.title ?? `Usage Heatmap (by ${metric})`;
	lines.push(title);

	// header - 6-char wide columns, day name centered
	const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	const headerCells = dayNames.map((d) => d.padStart(4).padEnd(6));
	lines.push(`        ${headerCells.join('')}`);

	// sort weeks chronologically
	const sortedWeeks = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));

	for (const [weekKey, days] of sortedWeeks) {
		const weekDate = new Date(weekKey);
		const weekLabel = weekDate.toLocaleDateString('en-US', {
			month: 'short',
			day: '2-digit',
		});

		const dayCells: string[] = [];
		// iterate Monday (1) to Sunday (0, treated as 7)
		for (let d = 1; d <= 7; d++) {
			const dayIndex = d % 7; // convert to 0-6 where 0=Sunday
			const entry = days.get(dayIndex);
			if (entry != null) {
				const intensity = getIntensity(getValue(entry));
				const char = HEATMAP_CHARS[intensity] ?? HEATMAP_CHARS[0];
				// center the char in 6-character column (2 spaces before, 3 after for single char)
				dayCells.push(`  ${char}   `);
			} else {
				dayCells.push('      ');
			}
		}

		lines.push(`${weekLabel}  ${dayCells.join('')}`);
	}

	// legend
	lines.push('');
	const formatValue = metric === 'cost' ? formatCostCompact : formatTokensCompact;
	const t0 = thresholds[0] ?? 0;
	const t1 = thresholds[1] ?? 0;
	const t2 = thresholds[2] ?? 0;
	const legendParts = [
		`${HEATMAP_CHARS[1]} < ${formatValue(t0)}`,
		`${HEATMAP_CHARS[2]} ${formatValue(t0)}-${formatValue(t1)}`,
		`${HEATMAP_CHARS[3]} ${formatValue(t1)}-${formatValue(t2)}`,
		`${HEATMAP_CHARS[4]} > ${formatValue(t2)}`,
	];
	lines.push(legendParts.join('   '));

	return lines.join('\n');
}

/**
 * Visual mode type for --visual flag.
 */
export type VisualMode = 'compact' | 'bar' | 'spark' | 'heatmap';

/**
 * Check if a string is a valid visual mode.
 */
export function isValidVisualMode(mode: string): mode is VisualMode {
	return ['compact', 'bar', 'spark', 'heatmap'].includes(mode);
}

/**
 * Entry for 5-minute window activity grid.
 */
export type ActivityEntry = {
	timestamp: string; // ISO timestamp
	cost: number;
	outputTokens: number;
};

/**
 * Options for day activity grid.
 */
export type DayActivityGridOptions = {
	/** Date to display (YYYY-MM-DD format, defaults to today) */
	date?: string;
	/** Timezone for display */
	timezone?: string;
	/** Current time for indicator (ISO timestamp, defaults to now) */
	currentTime?: string;
	/** Metric to visualize */
	metric?: 'cost' | 'output';
};

/**
 * Unicode block characters for 5-level activity intensity.
 */
const ACTIVITY_CHARS = [
	'\u00B7', // MIDDLE DOT (no activity)
	'\u2591', // LIGHT SHADE
	'\u2592', // MEDIUM SHADE
	'\u2593', // DARK SHADE
	'\u2588', // FULL BLOCK
] as const;

/**
 * Single-hue color for activity blocks.
 * Uses cyan for all intensity levels - the block density (░▒▓█) already
 * conveys intensity. Adding multiple colors creates visual noise.
 * Following Tufte: let the data speak, minimize chartjunk.
 */
const ACTIVITY_COLOR = colors.text.accent; // cyan for all blocks

/**
 * Create a day activity grid showing 1-minute resolution.
 * Each row is one hour (0-23), each character is one minute (60 per hour).
 * Labels at :00, :15, :30, :45 help with visual orientation.
 *
 * @example
 * createDayActivityGrid(entries, { date: '2025-01-11' })
 * // Returns:
 * // Activity Heatmap - Jan 11, 2025
 * //
 * // Hour  :00            :15            :30            :45                Cost
 * // ──────────────────────────────────────────────────────────────────────────
 * //   0  ············································································    -
 * //   7  ···░░░▒▒▒▓▓▓▒▒▒░░░···············································    $12.34
 * //   8  ▒▒▒▓▓▓███▓▓▓▒▒▒░░░···············································    $45.67
 * // ──────────────────────────────────────────────────────────────────────────
 * // Legend: · none  ░ low  ▒ medium  ▓ high  █ peak
 */
export function createDayActivityGrid(
	entries: ActivityEntry[],
	options: DayActivityGridOptions = {},
): string {
	const now = options.currentTime != null ? new Date(options.currentTime) : new Date();
	const targetDate = options.date ?? now.toISOString().slice(0, 10);
	const metric = options.metric ?? 'cost';

	// group entries into 1-minute buckets (24 hours × 60 minutes = 1440 total)
	const buckets: number[] = Array.from({ length: 1440 }, () => 0);
	// also track cost per hour for the right column
	const hourlyCost: number[] = Array.from({ length: 24 }, () => 0);

	for (const entry of entries) {
		const entryDate = new Date(entry.timestamp);
		// use local date to match local hours (getHours returns local time)
		const localYear = entryDate.getFullYear();
		const localMonth = String(entryDate.getMonth() + 1).padStart(2, '0');
		const localDay = String(entryDate.getDate()).padStart(2, '0');
		const entryDateStr = `${localYear}-${localMonth}-${localDay}`;

		// only include entries from the target date (in local time)
		if (entryDateStr !== targetDate) {
			continue;
		}

		const hour = entryDate.getHours();
		const minute = entryDate.getMinutes();
		const bucketIndex = hour * 60 + minute;

		const value = metric === 'cost' ? entry.cost : entry.outputTokens;
		const currentValue = buckets[bucketIndex] ?? 0;
		buckets[bucketIndex] = currentValue + value;

		// track hourly cost (always cost, not metric)
		hourlyCost[hour] = (hourlyCost[hour] ?? 0) + entry.cost;
	}

	// find max value for scaling
	const maxValue = Math.max(...buckets, 1); // avoid division by zero

	// calculate thresholds for 5 levels
	const getIntensity = (value: number): number => {
		if (value === 0) {
			return 0;
		}
		const ratio = value / maxValue;
		if (ratio <= 0.2) {
			return 1;
		}
		if (ratio <= 0.4) {
			return 2;
		}
		if (ratio <= 0.7) {
			return 3;
		}
		return 4;
	};

	// determine current time position for indicator
	const isToday = targetDate === now.toISOString().slice(0, 10);
	const currentHour = now.getHours();
	const currentMinute = now.getMinutes();

	const lines: string[] = [];

	// title with formatted date
	const displayDate = new Date(`${targetDate}T12:00:00`); // noon to avoid timezone issues
	const formattedDate = displayDate.toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
	lines.push(`Activity Heatmap - ${formattedDate}`);
	lines.push('');

	// header row with 15-minute markers (60 chars = 60 minutes, labels at 0, 15, 30, 45)
	const headerGrid = ' '.repeat(60).split('');
	headerGrid[0] = ':';
	headerGrid[1] = '0';
	headerGrid[2] = '0';
	headerGrid[15] = ':';
	headerGrid[16] = '1';
	headerGrid[17] = '5';
	headerGrid[30] = ':';
	headerGrid[31] = '3';
	headerGrid[32] = '0';
	headerGrid[45] = ':';
	headerGrid[46] = '4';
	headerGrid[47] = '5';
	const header = `Hour  ${headerGrid.join('')}      Cost`;
	lines.push(header);
	lines.push('\u2500'.repeat(header.length));

	// each row is one hour, each character is one minute
	for (let hour = 0; hour < 24; hour++) {
		const hourLabel = hour.toString().padStart(2, ' ');
		let cells = '';

		for (let minute = 0; minute < 60; minute++) {
			const bucketIndex = hour * 60 + minute;
			const value = buckets[bucketIndex];
			const intensity = getIntensity(value ?? 0);
			const baseChar: string = ACTIVITY_CHARS[intensity] ?? ACTIVITY_CHARS[0];

			// add current time indicator
			if (isToday && hour === currentHour && minute === currentMinute) {
				cells += colors.semantic.warning('\u25BC'); // current time marker in yellow
			} else if (isToday && hour === currentHour && minute > currentMinute) {
				// future minutes in current hour show as dim
				cells += colors.text.secondary('\u00B7');
			} else if (isToday && hour > currentHour) {
				// future hours show as dim
				cells += colors.text.secondary('\u00B7');
			} else if (intensity === 0) {
				// no activity - dim dot
				cells += colors.text.secondary(baseChar);
			} else {
				// activity blocks - single cyan color, density shows intensity
				cells += ACTIVITY_COLOR(baseChar);
			}
		}

		// format hourly cost with intensity-based coloring (rounded to nearest dollar)
		const hourCost = hourlyCost[hour] ?? 0;
		let costStr: string;
		if (hourCost > 0) {
			const roundedCost = Math.round(hourCost);
			const formattedCost = `$${roundedCost}`.padStart(8);
			// color cost based on relative value - use same cyan color with bold for high values
			const maxHourlyCost = Math.max(...hourlyCost, 1);
			const costRatio = hourCost / maxHourlyCost;
			if (costRatio >= 0.7) {
				// peak hours - bold cyan
				costStr = colors.text.emphasis(ACTIVITY_COLOR(formattedCost));
			} else if (costRatio >= 0.3) {
				// moderate hours - regular cyan
				costStr = ACTIVITY_COLOR(formattedCost);
			} else {
				// low hours - dim
				costStr = colors.text.secondary(formattedCost);
			}
		} else {
			costStr = colors.text.secondary('       -');
		}

		lines.push(`  ${hourLabel}  ${cells}  ${costStr}`);
	}

	lines.push('\u2500'.repeat(header.length));

	// legend with single blocks in single color (and current time if today)
	lines.push('');
	const legendParts = [
		`${colors.text.secondary(ACTIVITY_CHARS[0])} none`,
		`${ACTIVITY_COLOR(ACTIVITY_CHARS[1])} low`,
		`${ACTIVITY_COLOR(ACTIVITY_CHARS[2])} medium`,
		`${ACTIVITY_COLOR(ACTIVITY_CHARS[3])} high`,
		`${ACTIVITY_COLOR(ACTIVITY_CHARS[4])} peak`,
	];
	const legendText = `Legend: ${legendParts.join('  ')}`;

	if (isToday) {
		const timeStr = now.toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});
		const nowText = `Now: ${timeStr} \u25BC`;
		// right-align "Now:" to match header width
		const padding = header.length - legendText.length - nowText.length;
		lines.push(`${legendText}${' '.repeat(Math.max(2, padding))}${nowText}`);
	} else {
		lines.push(legendText);
	}

	// summary stats
	const totalValue = buckets.reduce((a, b) => a + b, 0);
	const activeCount = buckets.filter((v) => v > 0).length;
	// format total - round cost to nearest dollar, tokens use compact format
	// highlight total cost with bold cyan
	const totalStr =
		metric === 'cost'
			? colors.text.emphasis(ACTIVITY_COLOR(`$${Math.round(totalValue)}`))
			: formatTokensCompact(totalValue);

	lines.push('');
	lines.push(
		`Total: ${totalStr}  Active minutes: ${activeCount}/1440 (${Math.round((activeCount / 1440) * 100)}%)`,
	);

	return lines.join('\n');
}

// in-source tests
if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	const sampleData: ChartDataEntry[] = [
		{ date: '2025-01-07', cost: 786, outputTokens: 951000, inputTokens: 1100000 },
		{ date: '2025-01-08', cost: 403, outputTokens: 584000, inputTokens: 500000 },
		{ date: '2025-01-09', cost: 390, outputTokens: 230000, inputTokens: 620000 },
	];

	describe('createBarChart', () => {
		it('creates horizontal bar chart', () => {
			const result = createBarChart(sampleData, { width: 20 });
			expect(result).toContain('Jan 07');
			expect(result).toContain('Jan 08');
			expect(result).toContain('\u2588'); // bar character
		});

		it('handles empty data', () => {
			const result = createBarChart([]);
			expect(result).toBe('(no data)');
		});

		it('respects metric option', () => {
			const result = createBarChart(sampleData, { metric: 'output', width: 20 });
			expect(result).toContain('951K'); // output tokens
		});
	});

	describe('createFullSparkline', () => {
		it('creates annotated sparkline', () => {
			const result = createFullSparkline(sampleData);
			expect(result).toContain('Cost over time');
			expect(result).toContain('Avg:');
			expect(result).toContain('Total:');
		});

		it('shows min and max markers', () => {
			const result = createFullSparkline(sampleData);
			expect(result).toContain('^'); // max marker
			expect(result).toContain('v'); // min marker
		});

		it('handles empty data', () => {
			const result = createFullSparkline([]);
			expect(result).toBe('(no data)');
		});
	});

	describe('createHeatmap', () => {
		it('creates week-based heatmap', () => {
			const result = createHeatmap(sampleData);
			expect(result).toContain('Usage Heatmap');
			expect(result).toContain('Mon');
			expect(result).toContain('Sun');
		});

		it('includes legend', () => {
			const result = createHeatmap(sampleData);
			expect(result).toContain(HEATMAP_CHARS[1]);
			expect(result).toContain(HEATMAP_CHARS[4]);
		});

		it('handles empty data', () => {
			const result = createHeatmap([]);
			expect(result).toBe('(no data)');
		});
	});

	describe('isValidVisualMode', () => {
		it('validates known modes', () => {
			expect(isValidVisualMode('compact')).toBe(true);
			expect(isValidVisualMode('bar')).toBe(true);
			expect(isValidVisualMode('spark')).toBe(true);
			expect(isValidVisualMode('heatmap')).toBe(true);
		});

		it('rejects unknown modes', () => {
			expect(isValidVisualMode('unknown')).toBe(false);
			expect(isValidVisualMode('')).toBe(false);
		});
	});

	describe('createDayActivityGrid', () => {
		const sampleEntries: ActivityEntry[] = [
			{ timestamp: '2025-01-11T09:15:00Z', cost: 10, outputTokens: 1000 },
			{ timestamp: '2025-01-11T09:20:00Z', cost: 20, outputTokens: 2000 },
			{ timestamp: '2025-01-11T14:30:00Z', cost: 50, outputTokens: 5000 },
		];

		it('creates 24-row activity grid with 1-minute resolution', () => {
			const result = createDayActivityGrid(sampleEntries, {
				date: '2025-01-11',
				currentTime: '2025-01-10T12:00:00Z', // past date so no "now" indicator
			});
			expect(result).toContain('Activity Heatmap');
			expect(result).toContain('Hour');
			expect(result).toContain(':00');
			expect(result).toContain(':15');
			expect(result).toContain(':30');
			expect(result).toContain(':45');
		});

		it('shows legend with single character blocks', () => {
			const result = createDayActivityGrid(sampleEntries, {
				date: '2025-01-11',
				currentTime: '2025-01-10T12:00:00Z',
			});
			expect(result).toContain('Legend:');
			expect(result).toContain('none');
			expect(result).toContain('low');
			expect(result).toContain('peak');
		});

		it('shows summary stats with 1440 minute windows', () => {
			const result = createDayActivityGrid(sampleEntries, {
				date: '2025-01-11',
				currentTime: '2025-01-10T12:00:00Z',
			});
			expect(result).toContain('Total:');
			expect(result).toContain('Active minutes:');
			expect(result).toContain('/1440');
		});

		it('shows current time indicator for today', () => {
			const result = createDayActivityGrid(sampleEntries, {
				date: '2025-01-11',
				currentTime: '2025-01-11T14:32:00Z', // same day
			});
			expect(result).toContain('Now:');
			expect(result).toContain('\u25BC'); // down arrow
		});

		it('handles empty entries', () => {
			const result = createDayActivityGrid([], {
				date: '2025-01-11',
				currentTime: '2025-01-10T12:00:00Z',
			});
			expect(result).toContain('Activity Heatmap');
			expect(result).toContain('Active minutes: 0/1440');
		});

		it('shows hourly cost column', () => {
			const result = createDayActivityGrid(sampleEntries, {
				date: '2025-01-11',
				currentTime: '2025-01-10T12:00:00Z',
			});
			expect(result).toContain('Cost');
		});
	});
}
