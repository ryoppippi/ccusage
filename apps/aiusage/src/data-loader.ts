/**
 * @fileoverview Unified data loader for all AI services
 */

import { Result } from '@praha/byethrow';
import type { AIService, ServiceStatus, UnifiedUsageData } from './types.ts';
import { logger } from './logger.ts';

// Import data loaders from existing packages
import { loadDailyUsageData as loadClaudeDaily } from 'ccusage/data-loader';
import { loadMonthlyUsageData as loadClaudeMonthly } from 'ccusage/data-loader';

/**
 * Check which AI services have available data
 */
export async function checkServiceAvailability(): Promise<ServiceStatus[]> {
	const statuses: ServiceStatus[] = [];

	// Check Claude Code
	const claudeStatus = await checkClaudeAvailability();
	statuses.push(claudeStatus);

	// Check Codex CLI
	const codexStatus = await checkCodexAvailability();
	statuses.push(codexStatus);

	// Check Cursor (not yet implemented)
	statuses.push({
		service: 'cursor',
		available: false,
		error: 'Cursor support coming soon',
	});

	// Check Copilot (not yet implemented)
	statuses.push({
		service: 'copilot',
		available: false,
		error: 'Copilot support coming soon',
	});

	return statuses;
}

/**
 * Check if Claude Code data is available
 */
async function checkClaudeAvailability(): Promise<ServiceStatus> {
	const result = Result.try(() => {
		const data = loadClaudeDaily();
		return data.length > 0;
	});

	if (Result.isSuccess(result)) {
		return {
			service: 'claude',
			available: result.value,
			dataPath: '~/.claude or ~/.config/claude',
		};
	}

	return {
		service: 'claude',
		available: false,
		error: Result.isFailure(result) ? (result.error instanceof Error ? result.error.message : String(result.error)) : 'Unknown error',
	};
}

/**
 * Check if Codex CLI data is available
 */
async function checkCodexAvailability(): Promise<ServiceStatus> {
	// Import dynamically to avoid errors if codex package changes
	const result = Result.try(async () => {
		try {
			// Try to import codex data loader
			const { loadDailyUsageData } = await import('@ccusage/codex/src/data-loader.ts');
			const data = loadDailyUsageData();
			return data.length > 0;
		}
		catch {
			return false;
		}
	});

	if (Result.isSuccess(result)) {
		const hasData = await result.value;
		return {
			service: 'codex',
			available: hasData,
			dataPath: '~/.codex',
		};
	}

	return {
		service: 'codex',
		available: false,
		error: 'Codex data not found',
	};
}

/**
 * Load unified daily usage data from all available services
 */
export function loadUnifiedDailyData(): UnifiedUsageData[] {
	const allData: UnifiedUsageData[] = [];

	// Load Claude data
	const claudeResult = Result.try(() => {
		const data = loadClaudeDaily();
		return data.map(entry => ({
			service: 'claude' as AIService,
			date: entry.date,
			inputTokens: entry.inputTokens,
			outputTokens: entry.outputTokens,
			cacheCreateTokens: entry.cacheCreationTokens,
			cacheReadTokens: entry.cacheReadTokens,
			totalTokens: entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens,
			cost: entry.totalCost,
			models: entry.modelsUsed ?? [],
		}));
	});

	if (Result.isSuccess(claudeResult)) {
		allData.push(...claudeResult.value);
		logger.info(`Loaded ${claudeResult.value.length} Claude Code entries`);
	}
	else if (Result.isFailure(claudeResult)) {
		const errorMsg = claudeResult.error instanceof Error ? claudeResult.error.message : String(claudeResult.error);
		logger.warn('Failed to load Claude data:', errorMsg);
	}

	// TODO: Load Codex data
	// TODO: Load Cursor data
	// TODO: Load Copilot data

	return allData;
}

/**
 * Load unified monthly usage data from all available services
 */
export function loadUnifiedMonthlyData(): UnifiedUsageData[] {
	const allData: UnifiedUsageData[] = [];

	// Load Claude data
	const claudeResult = Result.try(() => {
		const data = loadClaudeMonthly();
		return data.map(entry => ({
			service: 'claude' as AIService,
			date: entry.month,
			inputTokens: entry.inputTokens,
			outputTokens: entry.outputTokens,
			cacheCreateTokens: entry.cacheCreationTokens,
			cacheReadTokens: entry.cacheReadTokens,
			totalTokens: entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens,
			cost: entry.totalCost,
			models: entry.modelsUsed ?? [],
		}));
	});

	if (Result.isSuccess(claudeResult)) {
		allData.push(...claudeResult.value);
		logger.info(`Loaded ${claudeResult.value.length} Claude Code monthly entries`);
	}
	else if (Result.isFailure(claudeResult)) {
		const errorMsg = claudeResult.error instanceof Error ? claudeResult.error.message : String(claudeResult.error);
		logger.warn('Failed to load Claude data:', errorMsg);
	}

	// TODO: Load Codex data
	// TODO: Load Cursor data
	// TODO: Load Copilot data

	return allData;
}
