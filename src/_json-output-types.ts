/**
 * @fileoverview JSON output interface types for daily command groupByProject function
 *
 * This module provides TypeScript interfaces for the JSON output structure
 * used by the daily command's groupByProject function, replacing the
 * unsafe Record<string, any[]> type with proper type definitions.
 *
 * @module json-output-types
 */

import type { DailyDate, ModelName } from './_types.ts';
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
