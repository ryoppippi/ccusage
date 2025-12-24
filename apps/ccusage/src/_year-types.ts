/**
 * Type definitions for year/wrapped report feature
 */

export type YearStats = {
	year: number;
	totalTokens: {
		input: number;
		output: number;
		cache_creation: number;
		cache_read: number;
		total: number;
	};
	totalCost: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	totalSessions: number;
	modelBreakdown: ModelStats[];
	monthlyTrend: MonthlyData[];
	dailyActivity: Map<string, DayActivity>;
	topProjects: ProjectStats[];
	peakHour: number;
	peakDayOfWeek: string;
};

export type ModelStats = {
	model: string;
	tokens: number;
	percentage: number;
	cost: number;
};

export type MonthlyData = {
	month: string;
	tokens: number;
	cost: number;
};

export type DayActivity = {
	date: string;
	tokens: number;
	level: HeatmapLevel;
};

export type ProjectStats = {
	project: string;
	tokens: number;
};

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;
