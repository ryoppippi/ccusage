/**
 * @fileoverview JSON output interface types for groupByProject functions
 *
 * This module provides TypeScript interfaces for the JSON output structures
 * used by groupByProject functions across all commands, replacing the
 * unsafe Record<string, any[]> type with proper type definitions.
 *
 * Based on Gemini Code Assist review comments (PR #183) to improve type safety.
 *
 * @module json-output-types
 */

import type { ActivityDate, DailyDate, ModelName, MonthlyDate, SessionId } from './_types.ts';
import type { ModelBreakdown } from './data-loader.ts';

/**
 * Interface for daily command JSON output structure (groupByProject)
 * Used in src/commands/daily.ts
 */
export type DailyProjectOutput = {
	date: DailyDate;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
};

/**
 * Interface for monthly command JSON output structure (groupByProject)
 * Used in src/commands/monthly.ts
 */
export type MonthlyProjectOutput = {
	month: MonthlyDate;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
};

/**
 * Interface for session command JSON output structure (groupByProject)
 * Used in src/commands/session.ts
 */
export type SessionProjectOutput = {
	sessionId: SessionId;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	lastActivity: ActivityDate;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
};

/**
 * Interface for blocks command JSON output structure (groupByProject)
 * Used in src/commands/blocks.ts
 *
 * Note: TokenCounts from SessionBlock uses different property names:
 * - cacheCreationInputTokens (instead of cacheCreationTokens)
 * - cacheReadInputTokens (instead of cacheReadTokens)
 */
export type BlockProjectOutput = {
	id: string;
	startTime: string; // ISO string from block.startTime.toISOString()
	endTime: string; // ISO string from block.endTime.toISOString()
	actualEndTime: string | null; // ISO string or null
	isActive: boolean;
	isGap: boolean;
	entries: number; // block.entries.length
	tokenCounts: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number; // Note: different naming from other commands
		cacheReadInputTokens: number; // Note: different naming from other commands
	};
	totalTokens: number; // Calculated sum
	costUSD: number;
	models: string[]; // Array of model names (not branded ModelName[])
	burnRate: {
		tokensPerMinute: number;
		costPerHour: number;
	} | null;
	projection: {
		totalTokens: number;
		totalCost: number;
		remainingMinutes: number;
	} | null;
};
