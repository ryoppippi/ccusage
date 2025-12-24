/**
 * Year report builder for Claude Code Wrapped
 */

import type { DailyUsage } from './data-loader.ts';
import type {
	DayActivity,
	HeatmapLevel,
	ModelStats,
	MonthlyData,
	ProjectStats,
	YearStats,
} from './_year-types.ts';

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(date: Date): string {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Calculate streak information from daily activity
 */
function calculateStreaks(sortedDates: string[]): {
	currentStreak: number;
	longestStreak: number;
} {
	if (sortedDates.length === 0) {
		return { currentStreak: 0, longestStreak: 0 };
	}

	const today = new Date();
	const todayStr = formatDate(today);

	let currentStreak = 0;
	let longestStreak = 0;
	let tempStreak = 0;
	let previousDate: Date | null = null;

	// Calculate longest streak
	for (const dateStr of sortedDates) {
		const currentDate = new Date(dateStr + 'T00:00:00');

		if (previousDate === null) {
			tempStreak = 1;
		}
		else {
			const dayDiff = Math.round(
				(currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24),
			);

			if (dayDiff === 1) {
				tempStreak++;
			}
			else {
				longestStreak = Math.max(longestStreak, tempStreak);
				tempStreak = 1;
			}
		}

		previousDate = currentDate;
	}

	longestStreak = Math.max(longestStreak, tempStreak);

	// Calculate current streak (ending today or most recent day)
	const lastDate = sortedDates[sortedDates.length - 1]!;
	const lastDateObj = new Date(lastDate + 'T00:00:00');
	const todayObj = new Date(todayStr + 'T00:00:00');
	const daysSinceLastActivity = Math.round(
		(todayObj.getTime() - lastDateObj.getTime()) / (1000 * 60 * 60 * 24),
	);

	if (daysSinceLastActivity > 1) {
		// Streak is broken
		currentStreak = 0;
	}
	else {
		// Count backwards from last activity
		currentStreak = 1;
		for (let i = sortedDates.length - 2; i >= 0; i--) {
			const prevDateStr = sortedDates[i]!;
			const currDateStr = sortedDates[i + 1]!;
			const prev = new Date(prevDateStr + 'T00:00:00');
			const curr = new Date(currDateStr + 'T00:00:00');
			const diff = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));

			if (diff === 1) {
				currentStreak++;
			}
			else {
				break;
			}
		}
	}

	return { currentStreak, longestStreak };
}

/**
 * Calculate heatmap level based on token quartiles
 */
function calculateHeatmapLevel(tokens: number, quartiles: number[]): HeatmapLevel {
	if (tokens === 0) return 0;
	if (tokens <= quartiles[0]!) return 1;
	if (tokens <= quartiles[1]!) return 2;
	if (tokens <= quartiles[2]!) return 3;
	return 4;
}

/**
 * Calculate quartiles from sorted values
 */
function calculateQuartiles(sortedValues: number[]): number[] {
	if (sortedValues.length === 0) return [0, 0, 0];

	const q1Index = Math.floor(sortedValues.length * 0.25);
	const q2Index = Math.floor(sortedValues.length * 0.50);
	const q3Index = Math.floor(sortedValues.length * 0.75);

	return [
		sortedValues[q1Index] ?? 0,
		sortedValues[q2Index] ?? 0,
		sortedValues[q3Index] ?? 0,
	];
}

/**
 * Get all dates in a year (YYYY-MM-DD format)
 */
function getAllDatesInYear(year: number): string[] {
	const dates: string[] = [];
	const start = new Date(Date.UTC(year, 0, 1));
	const end = new Date(Date.UTC(year, 11, 31));

	for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
		const yyyy = d.getUTCFullYear();
		const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
		const dd = String(d.getUTCDate()).padStart(2, '0');
		dates.push(`${yyyy}-${mm}-${dd}`);
	}

	return dates;
}

/**
 * Build comprehensive year report from daily usage data
 */
export function buildYearReport(
	dailyData: DailyUsage[],
	targetYear: number,
): YearStats | null {
	// Filter data for target year
	const yearStart = `${targetYear}-01-01`;
	const yearEnd = `${targetYear}-12-31`;

	const yearData = dailyData.filter(d => d.date >= yearStart && d.date <= yearEnd);

	if (yearData.length === 0) {
		return null;
	}

	// Initialize accumulators
	const dailyActivity = new Map<string, DayActivity>();
	const monthlyActivity = new Map<string, MonthlyData>();
	const modelActivity = new Map<string, { tokens: number; cost: number }>();
	const projectActivity = new Map<string, number>();

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheCreationTokens = 0;
	let totalCacheReadTokens = 0;
	let totalTotalTokens = 0;
	let totalCost = 0;

	// Process each day
	for (const day of yearData) {
		const monthKey = day.date.substring(0, 7); // YYYY-MM

		// Aggregate totals (include ALL token types: input, output, cache_creation, cache_read)
		const dayTotalTokens = day.inputTokens + day.outputTokens + day.cacheCreationTokens + day.cacheReadTokens;
		totalInputTokens += day.inputTokens;
		totalOutputTokens += day.outputTokens;
		totalCacheCreationTokens += day.cacheCreationTokens;
		totalCacheReadTokens += day.cacheReadTokens;
		totalTotalTokens += dayTotalTokens;
		totalCost += day.totalCost;

		// Daily activity
		dailyActivity.set(day.date, {
			date: day.date,
			tokens: dayTotalTokens,
			level: 0, // Will calculate after we have quartiles
		});

		// Monthly activity
		const monthData = monthlyActivity.get(monthKey) ?? {
			month: monthKey,
			tokens: 0,
			cost: 0,
		};
		monthData.tokens += dayTotalTokens;
		monthData.cost += day.totalCost;
		monthlyActivity.set(monthKey, monthData);

		// Model activity
		for (const modelBreakdown of day.modelBreakdowns) {
			const modelName = modelBreakdown.modelName;
			const modelTokens = modelBreakdown.inputTokens + modelBreakdown.outputTokens + modelBreakdown.cacheCreationTokens + modelBreakdown.cacheReadTokens;
			const existing = modelActivity.get(modelName) ?? { tokens: 0, cost: 0 };
			existing.tokens += modelTokens;
			existing.cost += modelBreakdown.cost;
			modelActivity.set(modelName, existing);
		}

		// Project activity (if available)
		if (day.project) {
			projectActivity.set(
				day.project,
				(projectActivity.get(day.project) ?? 0) + dayTotalTokens,
			);
		}
	}

	// Model breakdown with percentages
	const modelBreakdown: ModelStats[] = [];
	for (const [model, data] of modelActivity) {
		modelBreakdown.push({
			model,
			tokens: data.tokens,
			percentage: totalTotalTokens > 0 ? (data.tokens / totalTotalTokens) * 100 : 0,
			cost: data.cost,
		});
	}
	modelBreakdown.sort((a, b) => b.tokens - a.tokens);

	// Monthly trend (fill in missing months)
	const monthlyTrend: MonthlyData[] = [];
	for (let month = 1; month <= 12; month++) {
		const monthKey = `${targetYear}-${String(month).padStart(2, '0')}`;
		const data = monthlyActivity.get(monthKey);
		monthlyTrend.push(data ?? { month: monthKey, tokens: 0, cost: 0 });
	}

	// Calculate heatmap levels
	const activeDayTokens = Array.from(dailyActivity.values())
		.map(d => d.tokens)
		.filter(t => t > 0)
		.sort((a, b) => a - b);

	const quartiles = calculateQuartiles(activeDayTokens);

	// Fill in all days of the year
	const allDates = getAllDatesInYear(targetYear);
	for (const date of allDates) {
		if (!dailyActivity.has(date)) {
			dailyActivity.set(date, { date, tokens: 0, level: 0 });
		}
		else {
			const dayData = dailyActivity.get(date)!;
			dayData.level = calculateHeatmapLevel(dayData.tokens, quartiles);
		}
	}

	// Top projects
	const topProjects: ProjectStats[] = Array.from(projectActivity.entries())
		.map(([project, tokens]) => ({ project, tokens }))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, 5);

	// Peak hour and day (simplified - would need more detailed data)
	// For now, we'll set defaults since DailyUsage doesn't have hourly breakdown
	const peakHour = 14; // Default to 2 PM
	const peakDayOfWeek = 'Monday'; // Default

	// Calculate streaks
	const sortedActiveDates = Array.from(dailyActivity.keys())
		.filter(date => (dailyActivity.get(date)?.tokens ?? 0) > 0)
		.sort();

	const { currentStreak, longestStreak } = calculateStreaks(sortedActiveDates);

	// Count unique sessions (simplified - one per active day)
	const totalSessions = sortedActiveDates.length;

	return {
		year: targetYear,
		totalTokens: {
			input: totalInputTokens,
			output: totalOutputTokens,
			cache_creation: totalCacheCreationTokens,
			cache_read: totalCacheReadTokens,
			total: totalTotalTokens,
		},
		totalCost,
		activeDays: sortedActiveDates.length,
		currentStreak,
		longestStreak,
		totalSessions,
		modelBreakdown,
		monthlyTrend,
		dailyActivity,
		topProjects,
		peakHour,
		peakDayOfWeek,
	};
}
